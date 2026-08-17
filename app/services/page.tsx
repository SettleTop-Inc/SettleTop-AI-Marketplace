import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ServicesGrid from "@/components/home/ServicesGrid";

export const metadata: Metadata = {
  title: "Services — SettleTop",
  description:
    "Pipelines, assessments and managed registries, delivered against the same evidence standard the products hold themselves to.",
};

export default function ServicesPage() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <section className="pg-hero st-invert">
          <div className="st-shell">
            <p className="st-eyebrow">Services</p>
            <h1 className="pg-hero__title">Work we do alongside the products</h1>
            <p className="pg-hero__lede">
              Engagements that stand up the pipelines, produce the assessments and
              run the registries — held to the same evidence standard as
              everything we ship.
            </p>
          </div>
        </section>

        {/* The same component the homepage summarises with, minus its own
            section heading, so the two surfaces cannot describe the seven
            services differently. */}
        <ServicesGrid headless />
      </main>
      <SiteFooter />
    </>
  );
}
