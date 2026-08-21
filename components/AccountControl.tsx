"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "@/app/signin/actions";

type Me = { email: string | null; role: "signed_in" | "admin" } | null;

export default function AccountControl() {
  const [me, setMe] = useState<Me>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let off = false;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !off && (setMe(d as Me), setLoaded(true)))
      .catch(() => !off && setLoaded(true));
    return () => {
      off = true;
    };
  }, []);
  if (!loaded) return null;
  if (!me) return <Link className="st-btn st-btn--secondary" href="/signin">Sign in</Link>;
  return (
    <form action={signOut} className="st-account">
      <span className="st-account__email">{me.email}</span>
      <button className="st-btn st-btn--secondary" type="submit">Sign out</button>
    </form>
  );
}
