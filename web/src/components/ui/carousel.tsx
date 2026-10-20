import * as React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

/**
 * Native horizontal scroller (trackpad, touch, shift+wheel and the arrows all work) with snap points.
 * `data-prev` / `data-next` mark which edges still have content, so CSS can fade them.
 */
const Context = React.createContext<{ ref: React.RefObject<HTMLDivElement>; prev: boolean; next: boolean; scroll: (direction: 1 | -1) => void } | null>(null);
function useCarousel() {
  const value = React.useContext(Context);
  if (!value) throw new Error("Carousel components must be inside Carousel");
  return value;
}

export function Carousel({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [prev, setPrev] = React.useState(false);
  const [next, setNext] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => { setPrev(el.scrollLeft > 1); setNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1); };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", update); observer.disconnect(); };
  }, []);
  const scroll = React.useCallback((direction: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  }, []);
  return <Context.Provider value={{ ref, prev, next, scroll }}><section className={`image-carousel ${className}`} data-prev={prev || undefined} data-next={next || undefined} role="region" aria-roledescription="轮播图" aria-label="图片" onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); scroll(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); scroll(1); }
  }}>{children}</section></Context.Provider>;
}
export function CarouselContent({ children }: React.PropsWithChildren) {
  const { ref } = useCarousel();
  return <div className="image-carousel-viewport" ref={ref}><div className="image-carousel-track">{children}</div></div>;
}
export function CarouselItem({ children }: React.PropsWithChildren) {
  return <div className="image-carousel-item" role="group" aria-roledescription="幻灯片">{children}</div>;
}
export function CarouselPrevious() {
  const { prev, scroll } = useCarousel();
  return <button type="button" className="image-carousel-arrow previous" disabled={!prev} aria-label="上一组图片" onClick={() => scroll(-1)}><ArrowLeft size={16} /></button>;
}
export function CarouselNext() {
  const { next, scroll } = useCarousel();
  return <button type="button" className="image-carousel-arrow next" disabled={!next} aria-label="下一组图片" onClick={() => scroll(1)}><ArrowRight size={16} /></button>;
}
