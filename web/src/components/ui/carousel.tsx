import * as React from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ArrowLeft, ArrowRight } from "lucide-react";

type API = ReturnType<typeof useEmblaCarousel>[1];
const Context = React.createContext<{ ref: ReturnType<typeof useEmblaCarousel>[0]; api: API; prev: boolean; next: boolean } | null>(null);
function useCarousel() {
  const value = React.useContext(Context);
  if (!value) throw new Error("Carousel components must be inside Carousel");
  return value;
}

export function Carousel({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) {
  const [ref, api] = useEmblaCarousel({ align: "start", loop: false });
  const [prev, setPrev] = React.useState(false);
  const [next, setNext] = React.useState(false);
  React.useEffect(() => {
    if (!api) return;
    const update = () => { setPrev(api.canScrollPrev()); setNext(api.canScrollNext()); };
    update();
    api.on("select", update).on("reInit", update);
    return () => { api.off("select", update).off("reInit", update); };
  }, [api]);
  return <Context.Provider value={{ ref, api, prev, next }}><section className={`image-carousel ${className}`} role="region" aria-roledescription="轮播图" aria-label="图片" onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); api?.scrollPrev(); }
    if (event.key === "ArrowRight") { event.preventDefault(); api?.scrollNext(); }
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
  const { api, prev } = useCarousel();
  return <button type="button" className="image-carousel-arrow previous" disabled={!prev} aria-label="上一组图片" onClick={() => api?.scrollPrev()}><ArrowLeft size={16} /></button>;
}
export function CarouselNext() {
  const { api, next } = useCarousel();
  return <button type="button" className="image-carousel-arrow next" disabled={!next} aria-label="下一组图片" onClick={() => api?.scrollNext()}><ArrowRight size={16} /></button>;
}
