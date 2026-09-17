import { getRequestContext } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  if (await getRequestContext()) redirect("/");
  return (
    <main className="login">
      <section className="card stack">
        <div>
          <h1>运营者登录</h1>
          <p className="muted">会话使用 HttpOnly cookie；客户范围由服务端 membership 校验。</p>
        </div>
        <form action="/api/auth/login" method="post" className="stack">
          <label>邮箱<input name="email" type="email" defaultValue="operator@example.local" required /></label>
          <label>密码<input name="password" type="password" defaultValue="change-this-local-password" required /></label>
          <button type="submit">登录演示客户</button>
        </form>
        <div className="warning">本地默认密码仅用于开发。正式部署前必须通过环境变量修改并重新创建账号。</div>
      </section>
    </main>
  );
}
