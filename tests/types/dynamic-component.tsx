export interface WidgetProps { label: string; count?: number }
export default function Widget({ label, count = 0 }: WidgetProps) {
  return <button>{label}: {count}</button>;
}
export function NamedWidget({ enabled }: { enabled: boolean }) {
  return <span>{enabled ? 'enabled' : 'disabled'}</span>;
}
