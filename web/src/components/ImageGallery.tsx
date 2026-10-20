import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeft, ArrowRight, Download, ImageOff, X } from "lucide-react";
import { Api, type ImageAsset } from "../api";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "./ui/carousel";

type LoadedImage = ImageAsset & { url?: string; error?: boolean };

/** Shared by uploaded and generated image groups; URLs never contain credentials. */
export function ImageGallery({ images, api, sessionId }: { images: ImageAsset[]; api: Api; sessionId: string }) {
  // Object URLs by image id; images that arrive later (streaming) load without reloading the rest.
  const [urls, setUrls] = useState<Record<string, string | false>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const requested = useRef(new Map<string, AbortController>());
  const created = useRef<string[]>([]);
  useEffect(() => {
    for (const image of images) {
      if (requested.current.has(image.id)) continue;
      const controller = new AbortController();
      requested.current.set(image.id, controller);
      void api.image(sessionId, image.id, controller.signal).then((blob) => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        created.current.push(url);
        setUrls((current) => ({ ...current, [image.id]: url }));
      }).catch(() => {
        if (!controller.signal.aborted) setUrls((current) => ({ ...current, [image.id]: false }));
      });
    }
  }, [api, sessionId, images]);
  useEffect(() => () => {
    requested.current.forEach((controller) => controller.abort());
    created.current.forEach((url) => URL.revokeObjectURL(url));
    requested.current = new Map();
    created.current = [];
  }, [api, sessionId]);
  const loaded: LoadedImage[] = images.map((image) => ({ ...image, url: urls[image.id] || undefined, error: urls[image.id] === false }));
  const current = selected === null ? undefined : loaded[selected];
  const tile = (image: LoadedImage, index: number) => <button type="button" className="gallery-tile" disabled={!image.url} onClick={() => setSelected(index)} aria-label={`查看 ${image.name}`}>
    {image.url ? <img src={image.url} alt={image.name} loading="lazy" /> : <span className="gallery-placeholder">{image.error ? <><ImageOff size={22} />图片加载失败</> : "加载图片…"}</span>}
  </button>;
  return <>
    {images.length === 1 ? <div className="image-gallery single">{loaded[0] && tile(loaded[0], 0)}</div> : <Carousel>
      <CarouselContent>{loaded.map((image, index) => <CarouselItem key={image.id}>{tile(image, index)}</CarouselItem>)}</CarouselContent>
      <CarouselPrevious /><CarouselNext />
    </Carousel>}
    <Dialog.Root open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="image-lightbox-backdrop" />
        <Dialog.Popup className="image-lightbox" onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && selected !== null) { event.preventDefault(); setSelected(Math.max(0, selected - 1)); }
          if (event.key === "ArrowRight" && selected !== null) { event.preventDefault(); setSelected(Math.min(loaded.length - 1, selected + 1)); }
        }}>
          <header>
            <Dialog.Title>{current?.name ?? "图片预览"}</Dialog.Title>
            <span aria-live="polite">{selected === null ? 0 : selected + 1} / {loaded.length}</span>
            {current?.url && <a href={current.url} download={current.name} aria-label="下载图片" title="下载图片"><Download size={18} /></a>}
            <Dialog.Close aria-label="关闭预览"><X size={20} /></Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">使用左右方向键切换图片，Escape 关闭预览。</Dialog.Description>
          <div className="image-lightbox-stage">
            {current?.url ? <img src={current.url} alt={current.name} /> : <span>{current?.error ? "图片加载失败" : "加载图片…"}</span>}
          </div>
          <footer>
            <button type="button" aria-label="上一张图片" disabled={selected === null || selected === 0} onClick={() => setSelected((index) => Math.max(0, (index ?? 0) - 1))}><ArrowLeft size={18} /></button>
            <button type="button" aria-label="下一张图片" disabled={selected === null || selected === loaded.length - 1} onClick={() => setSelected((index) => Math.min(loaded.length - 1, (index ?? 0) + 1))}><ArrowRight size={18} /></button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
