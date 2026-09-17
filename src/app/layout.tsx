import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "海外社媒 AI 运营工作台",
  description: "带确定性审批、发布和线索交接的海外社媒运营工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
