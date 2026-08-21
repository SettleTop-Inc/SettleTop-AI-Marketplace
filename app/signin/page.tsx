import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { signIn, signInWithProvider } from "./actions";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;
  return (
    <>
      <SiteHeader />
      <main className="st-shell" style={{ padding: "4rem 0", maxWidth: 460 }}>
        <h1>Sign in</h1>
        {sent ? (
          <p>Check your email for a sign-in link.</p>
        ) : (
          <>
            <div className="st-signin__social">
              <form action={signInWithProvider.bind(null, "google")}>
                <button className="st-btn st-btn--secondary" type="submit">Continue with Google</button>
              </form>
              <form action={signInWithProvider.bind(null, "github")}>
                <button className="st-btn st-btn--secondary" type="submit">Continue with GitHub</button>
              </form>
              <form action={signInWithProvider.bind(null, "linkedin_oidc")}>
                <button className="st-btn st-btn--secondary" type="submit">Continue with LinkedIn</button>
              </form>
            </div>
            <p className="st-signin__or">or</p>
            <form action={signIn}>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoComplete="email" />
              <button className="st-btn st-btn--primary" type="submit">Email me a sign-in link</button>
            </form>
            {error === "email" && <p>Enter a valid email address.</p>}
            {error === "limited" && <p>We cannot create the account right now. Try again later.</p>}
            {error === "send" && <p>That did not send. Request a new link.</p>}
            {error === "oauth" && <p>That sign-in did not start. Try again.</p>}
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
