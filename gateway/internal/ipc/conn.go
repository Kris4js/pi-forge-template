package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

var ErrClosed = errors.New("ipc connection closed")

// Handler serves a runtime->gateway request. It runs on its own goroutine and may block
// (e.g. waiting for a human approval).
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// NotifyHandler serves a runtime->gateway notification. Notifications are delivered in order
// on the read loop, so they must not block.
type NotifyHandler func(params json.RawMessage)

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

type Conn struct {
	w        io.Writer
	writeMu  sync.Mutex
	nextID   atomic.Int64
	mu       sync.Mutex
	pending  map[int64]chan message
	closed   bool
	handlers map[string]Handler
	notifies map[string]NotifyHandler
	ctx      context.Context
	cancel   context.CancelFunc
}

func NewConn(w io.Writer, handlers map[string]Handler, notifies map[string]NotifyHandler) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &Conn{w: w, pending: map[int64]chan message{}, handlers: handlers, notifies: notifies, ctx: ctx, cancel: cancel}
}

// Call sends a request and decodes the result into out (which may be nil).
func (c *Conn) Call(ctx context.Context, method string, params, out any) error {
	id := c.nextID.Add(1)
	ch := make(chan message, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	idRaw, _ := json.Marshal(id)
	if err := c.send(message{JSONRPC: "2.0", ID: idRaw, Method: method, Params: raw}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case resp, ok := <-ch:
		if !ok {
			return ErrClosed
		}
		if resp.Error != nil {
			return resp.Error
		}
		if out != nil && len(resp.Result) > 0 {
			return json.Unmarshal(resp.Result, out)
		}
		return nil
	}
}

// Serve reads messages until r ends, then fails every pending call.
func (c *Conn) Serve(r io.Reader) error {
	reader := bufio.NewReaderSize(r, 1<<20)
	var readErr error
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 1 {
			c.dispatch(line)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}
	c.Close()
	return readErr
}

func (c *Conn) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	c.cancel()
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

func (c *Conn) dispatch(line []byte) {
	var m message
	if err := json.Unmarshal(line, &m); err != nil {
		return
	}
	if m.Method == "" {
		var id int64
		if json.Unmarshal(m.ID, &id) != nil {
			return
		}
		c.mu.Lock()
		ch := c.pending[id]
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
		return
	}
	if len(m.ID) == 0 || string(m.ID) == "null" {
		if h := c.notifies[m.Method]; h != nil {
			h(m.Params)
		}
		return
	}
	go c.serveRequest(m)
}

func (c *Conn) serveRequest(m message) {
	h := c.handlers[m.Method]
	if h == nil {
		_ = c.send(message{JSONRPC: "2.0", ID: m.ID, Error: &Error{Code: -32601, Message: "unknown method " + m.Method}})
		return
	}
	result, err := h(c.ctx, m.Params)
	if err != nil {
		var rpcErr *Error
		if !errors.As(err, &rpcErr) {
			rpcErr = &Error{Code: -32603, Message: err.Error()}
		}
		_ = c.send(message{JSONRPC: "2.0", ID: m.ID, Error: rpcErr})
		return
	}
	raw, err := json.Marshal(result)
	if err != nil {
		raw = []byte("null")
	}
	_ = c.send(message{JSONRPC: "2.0", ID: m.ID, Result: raw})
}

func (c *Conn) send(m message) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.w.Write(append(raw, '\n')); err != nil {
		return fmt.Errorf("ipc write: %w", err)
	}
	return nil
}
