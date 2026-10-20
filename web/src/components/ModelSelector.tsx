import { ChevronDown } from "lucide-react";
import { Fragment } from "react";
import type { ModelsResult } from "../api";
import { ProviderIcon } from "../lib/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export const EFFORT_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

type Props = {
  catalog: ModelsResult;
  model: string;
  effort: string;
  onModel: (key: string) => void;
  onEffort: (level: string) => void;
};

/**
 * shadcn AI Elements "Model Selector": one menu picks the model the agent runs, the other how hard
 * it thinks. Only models registered in the runtime's .env are offered.
 */
export function ModelSelector({ catalog, model, effort, onModel, onEffort }: Props) {
  const current = catalog.models.find((m) => m.key === model) ?? catalog.models[0];
  const groups = [...new Set(catalog.models.map((m) => m.group))];
  if (!current) return null;

  return (
    <div className="model-selector">
      <DropdownMenu>
        <DropdownMenuTrigger className="selector-trigger model" aria-label={`模型：${current.label}`} title={current.label}>
          <ProviderIcon model={current.label} size={14} />
          <span className="selector-label">{current.name}</span>
          <ChevronDown className="chevron-icon" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="model-menu">
          <DropdownMenuRadioGroup value={current.key} onValueChange={(value) => onModel(String(value))}>
            {groups.map((group, index) => (
              <Fragment key={group}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{group}</DropdownMenuLabel>
                  {catalog.models
                    .filter((m) => m.group === group)
                    .map((m) => (
                      <DropdownMenuRadioItem key={m.key} value={m.key} closeOnClick title={m.label}>
                        <ProviderIcon model={m.label} size={14} />
                        {m.name}
                      </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuGroup>
              </Fragment>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {current.reasoning && (
        <DropdownMenu>
          <DropdownMenuTrigger className="selector-trigger effort" aria-label={`思考强度：${EFFORT_LABELS[effort] ?? effort}`}>
            <span className="muted">思考</span>
            <span className="selector-label">{EFFORT_LABELS[effort] ?? effort}</span>
            <ChevronDown className="chevron-icon" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="effort-menu">
            <DropdownMenuGroup>
              <DropdownMenuLabel>思考强度</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={effort} onValueChange={(value) => onEffort(String(value))}>
                {catalog.thinkingLevels.map((level) => (
                  <DropdownMenuRadioItem key={level} value={level} closeOnClick>
                    {EFFORT_LABELS[level] ?? level}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
