import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readFile } from "node:fs/promises";
import path from "node:path";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { NEWS } from "@/lib/site-content";

type Params = Promise<{ slug: string }>;

export function generateStaticParams() {
  return NEWS.map((n) => ({ slug: n.slug }));
}

const bodyFor = async (slug: string) => {
  try {
    return await readFile(
      path.join(process.cwd(), "content", "news", `${slug}.html`),
      "utf8"
    );
  } catch {
    // An index entry with no imported body. Better to 404 than to render a
    // headline over nothing.
    return null;
  }
};

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const item = NEWS.find((n) => n.slug === slug);
  if (!item) return { title: "Not found — SettleTop" };
  return { title: `${item.title} — SettleTop` };
}

export default async function ArticlePage({ params }: { params: Params }) {
  const { slug } = await params;
  const item = NEWS.find((n) => n.slug === slug);
  if (!item) notFound();

  const body = await bodyFor(slug);
  if (!body) notFound();

  return (
    <>
      <SiteHeader />
      <main id="top">
        <article>
          <div className="pg-hero st-invert">
            <div className="st-shell">
              <Link className="st-back" href="/news">
                ← All news
              </Link>
              <p className="st-eyebrow">
                {item.date}
                {item.categories.length > 0 && ` · ${item.categories.join(" · ")}`}
              </p>
              <h1 className="pg-hero__title">{item.title}</h1>
            </div>
          </div>

          <div className="hm-section">
            <div className="st-shell">
              {/* The markup was rebuilt from an allowlist at import — see
                  scripts/import-news.mjs — so no attribute survives except
                  href on links and src/alt on images, and the files are
                  committed and reviewed rather than fetched at runtime. */}
              <div
                className="st-prose ar-body"
                dangerouslySetInnerHTML={{ __html: body }}
              />
            </div>
          </div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
