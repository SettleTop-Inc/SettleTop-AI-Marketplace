import { gradientFor, initials } from "@/lib/present";

/**
 * The agent mark.
 *
 * Shows the publisher's real logo when the registry actually HOLDS a copy —
 * `logo` is our archived URL, never the publisher's CDN. Hotlinking someone
 * else's CDN would mean the site silently changes when they swap the file, and
 * breaks when they delete it. If we have not archived it, we show initials
 * rather than borrowing an image we do not hold.
 */
export default function AgentLogo({
  name,
  id,
  logo,
  large = false,
}: {
  name: string;
  id: string;
  logo?: string | null;
  large?: boolean;
}) {
  const cls = `agent-logo ${large ? "large " : ""}${logo ? "has-logo" : gradientFor(id)}`;
  if (!logo) return <div className={cls}>{initials(name)}</div>;
  return (
    <div
      className={cls}
      style={{ background: "#fff", border: "1px solid #e7ebf2", overflow: "hidden" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logo}
        alt={`${name} logo`}
        loading="lazy"
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </div>
  );
}
