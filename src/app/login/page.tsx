import { getRequestContext } from "@/lib/auth";
import { Button, FormField } from "@/components/ui";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  if (await getRequestContext()) redirect("/");
  return (
    <main className="login-shell">
      <section className="login-brand" aria-label="Aarin SocialOps">
        <div className="login-brand-lockup">
          <span>Aarin</span>
          <strong>SocialOps</strong>
        </div>
        <p>Social operations workspace</p>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-copy">
          <p className="eyebrow">Aarin SocialOps</p>
          <h1 id="login-title">登录工作区</h1>
          <p>使用你的运营账号继续。</p>
        </div>
        <form action="/api/auth/login" method="post" className="form-stack">
          <FormField label="邮箱" htmlFor="login-email">
            <input id="login-email" name="email" type="email" autoComplete="username" required />
          </FormField>
          <FormField label="密码" htmlFor="login-password">
            <input id="login-password" name="password" type="password" autoComplete="current-password" required />
          </FormField>
          <Button type="submit">继续</Button>
        </form>
      </section>
    </main>
  );
}
