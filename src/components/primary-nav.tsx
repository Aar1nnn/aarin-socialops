"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "总览", icon: "overview" },
  { href: "/content", label: "内容", icon: "content" },
  { href: "/calendar", label: "日历", icon: "calendar" },
  { href: "/products", label: "产品", icon: "products" },
  { href: "/brand", label: "品牌", icon: "brand" },
  { href: "/analytics", label: "数据分析", icon: "analytics" },
  { href: "/insights", label: "互动与线索", icon: "data" },
  { href: "/connections", label: "平台连接", icon: "connections" },
  { href: "/settings", label: "设置", icon: "settings" },
] as const;

function NavIcon({ name }: { name: (typeof NAV_ITEMS)[number]["icon"] }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75 };
  if (name === "overview") return <svg {...common} aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></svg>;
  if (name === "content") return <svg {...common} aria-hidden="true"><path d="M6 3h9l3 3v15H6zM9 11h6M9 15h6" /></svg>;
  if (name === "calendar") return <svg {...common} aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM3 9h18M8 2v4M16 2v4" /></svg>;
  if (name === "products") return <svg {...common} aria-hidden="true"><path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10" /></svg>;
  if (name === "brand") return <svg {...common} aria-hidden="true"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4ZM8 11h8M8 15h5" /></svg>;
  if (name === "analytics") return <svg {...common} aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
  if (name === "data") return <svg {...common} aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>;
  if (name === "connections") return <svg {...common} aria-hidden="true"><path d="M8.5 15.5 6 18a3 3 0 0 1-4-4l3.5-3.5a3 3 0 0 1 4.2 0M15.5 8.5 18 6a3 3 0 0 1 4 4l-3.5 3.5a3 3 0 0 1-4.2 0M8 16l8-8" /></svg>;
  return <svg {...common} aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
}

export function PrimaryNav() {
  const pathname = usePathname();
  return (
    <nav className="primary-nav" aria-label="主要导航">
      {NAV_ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
