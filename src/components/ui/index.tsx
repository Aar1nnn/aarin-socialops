import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { getStatusPresentation, type StatusTone } from "@/lib/presentation/status";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({ variant = "primary", size = "md", className, ...props }: ButtonProps) {
  return <button className={classNames("button", `button-${variant}`, `button-${size}`, className)} {...props} />;
}

export function StatusIndicator({
  value,
  label,
  tone,
  compact = false,
}: {
  value?: string | null;
  label?: string;
  tone?: StatusTone;
  compact?: boolean;
}) {
  const presentation = getStatusPresentation(value);
  return (
    <span className={classNames("status-indicator", `status-${tone ?? presentation.tone}`, compact && "status-compact")}>
      <span className="status-dot" aria-hidden="true" />
      <span>{label ?? presentation.label}</span>
    </span>
  );
}

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        <h2>{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </header>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

export function Notice({
  title,
  children,
  tone = "info",
}: {
  title?: string;
  children: ReactNode;
  tone?: "info" | "warning" | "danger" | "success";
}) {
  return (
    <div className={classNames("notice", `notice-${tone}`)} role={tone === "danger" ? "alert" : "note"}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function FormField({
  label,
  htmlFor,
  helper,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  helper?: string;
  children: ReactNode;
  className?: string;
}) {
  const helperId = helper ? `${htmlFor}-helper` : undefined;
  const child = helper && helperId && isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": Array.from(new Set([
          (children as ReactElement<{ "aria-describedby"?: string }>).props["aria-describedby"],
          helperId,
        ].filter(Boolean))).join(" "),
      })
    : children;
  return (
    <div className={classNames("form-field", className)}>
      <label htmlFor={htmlFor}>{label}</label>
      {child}
      {helper ? <p className="field-helper" id={helperId}>{helper}</p> : null}
    </div>
  );
}
