"use client";

export default function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const nums = Array.from({ length: pageCount }, (_, i) => i + 1).filter(
    (n) => n === 1 || n === pageCount || Math.abs(n - page) <= 2
  );

  return (
    <nav className="reg-pages" aria-label="Result pages">
      <button className="reg-page" onClick={() => onPage(page - 1)} disabled={page === 1}>
        ‹
      </button>
      {nums.map((n, i) => (
        <span key={n} style={{ display: "contents" }}>
          {i > 0 && n - nums[i - 1] > 1 && <span className="reg-page" aria-hidden="true">…</span>}
          <button
            className="reg-page"
            aria-current={n === page ? "page" : undefined}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        </span>
      ))}
      <button className="reg-page" onClick={() => onPage(page + 1)} disabled={page === pageCount}>
        ›
      </button>
    </nav>
  );
}
