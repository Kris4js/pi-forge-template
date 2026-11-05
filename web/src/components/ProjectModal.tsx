import { useState } from "react";
import { ApiError, type Api, type Project } from "../api";
import { Button, Modal } from "../ui";

export function ProjectModal({ api, project, onSave, onDelete, onClose }: {
  api: Api;
  project?: Project;
  onSave: (project: Project, created: boolean) => void;
  onDelete: (project: Project) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const body = { name: name.trim(), instructions };
      const saved = project ? await api.updateProject(project.id, body) : await api.createProject(body);
      onSave(saved, !project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!project || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteProject(project.id);
      onDelete(project);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "项目中还有会话，请先删除其中的会话。" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={deleting ? "删除项目？" : project ? "项目设置" : "创建项目"} className="project-modal" onClose={() => { if (!busy) onClose(); }}>
      {deleting ? (
        <>
          <p className="modal-description">删除“{project?.name}”？仅可删除没有会话的项目。</p>
          {error && <p className="project-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <Button variant="outline" disabled={busy} onClick={() => { setDeleting(false); setError(undefined); }}>取消</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? "删除中…" : "删除项目"}</Button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="field">
            项目名称
            <input autoFocus required maxLength={80} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            共享项目指令
            <textarea rows={8} maxLength={20000} value={instructions} disabled={busy} onChange={(e) => setInstructions(e.target.value)} />
          </label>
          {error && <p className="project-error" role="alert">{error}</p>}
          <div className="modal-actions">
            {project && <Button className="project-delete" variant="danger" disabled={busy} onClick={() => { setDeleting(true); setError(undefined); }}>删除项目</Button>}
            <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "保存中…" : project ? "保存" : "创建"}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
