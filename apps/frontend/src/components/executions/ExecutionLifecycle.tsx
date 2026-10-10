import { presentLifecycleState, type LifecycleStep } from "../../features/executions/executionLifecycle";
import { TimestampValue } from "../../features/executions/ExecutionValue";
import { Badge } from "../ui/Badge";

/**
 * An execution's lifecycle as one ordered line of steps. Pure render: the steps
 * come from deriveExecutionLifecycle, built only from stored records, and each
 * state is spelled out in text (never colour alone). Read-only: no control.
 */
export function ExecutionLifecycle({ steps }: { steps: readonly LifecycleStep[] }) {
  return (
    <div className="space-y-2">
      {/* Wraps by the space it actually has (a detail panel or a page section), not by the viewport. */}
      <ol aria-label="Execution lifecycle" className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2" data-testid="execution-lifecycle">
        {steps.map((step, index) => {
          const shown = presentLifecycleState(step.state);
          return (
            <li key={step.id} data-step={step.id} data-state={step.state} className="min-w-0 space-y-1 rounded-lg border border-surface-border bg-surface/60 p-2">
              <p className="flex items-baseline gap-1.5 text-xs font-semibold text-slate-200">
                <span className="tabular-nums text-[10px] text-slate-500">{index + 1}</span>
                <span className="min-w-0 break-words">{step.label}</span>
              </p>
              <Badge tone={shown.tone}>
                <span aria-hidden="true" className="mr-1">
                  {shown.marker}
                </span>
                {shown.label}
              </Badge>
              <p className="break-words text-[11px] leading-snug text-slate-400">{step.detail}</p>
              {step.at !== null && (
                <p className="text-[11px] text-slate-500">
                  <TimestampValue value={step.at} />
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-slate-500">
        Built only from stored records (execution, orders, protection state, admissions, recorded status changes). “Not recorded” means unknown, never assumed done. No exchange
        call is made to draw this.
      </p>
    </div>
  );
}
