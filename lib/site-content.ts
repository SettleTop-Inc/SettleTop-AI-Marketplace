/**
 * Copy carried across from settletop.com — the Company, Partners and News
 * sections, reproduced rather than rewritten.
 *
 * Kept as data in one module so the wording has a single home and the page
 * components stay presentational. Nothing here is invented: the prose is the
 * live site's, the people and affiliations are as published, and every news
 * item keeps its own date and category.
 *
 * News items link out to the live articles because their bodies have not been
 * migrated. Each href was paired with its title from the DOM rather than by
 * list position — settletop.com has at least one article whose slug does not
 * match its headline (the SBIR Phase II release sits under a Montgomery IT
 * Summit slug), so pairing by index would have pointed it at the wrong story.
 */

export const NEWS_BASE = "https://www.settletop.com/news";

export const COMPANY = {
  title: "About SettleTop",
  lede: "Your partner for trusted AI-assisted development.",
  body: [
    "SettleTop is an AI data provenance and intelligence company focused on giving organizations clarity and confidence in their AI development. Our CodeRoot Platform maps every contribution—whether human-written, AI-assisted, or both—providing full traceability that restores confidence and trust across the modern AI supply chain. Our system-level graph connects provenance data with risk, compliance, and governance insights, enabling teams to accelerate development while strengthening trust, security, and value.",
    "With SettleTop, enterprises and defense organizations alike can move beyond code visibility to actionable intelligence—transforming how AI is created, managed, and trusted in today’s ever-changing world.",
  ],
  teamIntro:
    "SettleTop is led by a team of experienced innovators, technologists, and strategists who bring decades of expertise across AI, software, cybersecurity, and enterprise transformation. Our leaders combine deep technical knowledge with a clear vision for the future of AI data provenance and intelligence, software risk and data analytics. Together, the team is united by a shared mission: to deliver clarity, confidence, and measurable value in today’s AI development lifecycle.",
  team: [
    { name: "Sunny Ahn", role: "Chief Executive Officer" },
    { name: "Niles Madison", role: "Chief Product Officer" },
    { name: "Anthony Sacco", role: "Chief Technology Officer" },
    { name: "Paul Grepps", role: "VP, Data and AI" },
    { name: "Jessica Sweet", role: "Advisor, Governance, SCRM" },
    { name: "Christyne Vachon", role: "Chief of Staff" },
  ],
  advisors: [
    {
      name: "Dr. Micah Adler",
      role: "Visiting Scientist",
      detail: "MIT Computer Science and Artificial Intelligence Lab (CSAIL)",
    },
    {
      name: "Gary Connor",
      role: "Brigadier General",
      detail: "United States Air Force (Retired)",
    },
    { name: "Bill Ledingham", role: "Former CTO", detail: "Black Duck Software" },
    { name: "Jim Trowhill", role: "Former Partner", detail: "Accenture Federal" },
  ],
  joinTitle: "Join the team",
  joinBody:
    "At SettleTop, we believe innovation thrives where trust, collaboration, and purpose intersect. We foster a culture that values curiosity, accountability, and impact—encouraging our team to challenge assumptions, build with integrity, and deliver solutions that matter. Guided by transparency and a systems-level mindset, we empower people to grow, share ideas openly, and take ownership of outcomes. Above all, we are united by a commitment to helping organizations navigate the complexity of AI with clarity and confidence.",
  joinHref: "https://www.settletop.com/careers",
} as const;

export const PARTNERS = {
  title: "Partner with SettleTop",
  lede: "Let’s make AI development more transparent, secure and trusted.",
  eraTitle: "Join the New Era in AI Development",
  eraBody:
    "We believe that the future of AI (and software) is collaborative—humans, AI, and open source all contributing together. Our partner ecosystem includes the world’s most innovative AI-assisted development tools, spanning the entire AI development lifecycle. By working together, we bring traceability, provenance, and governance to AI.",
  whyTitle: "Why Partner with Us?",
  whyBody:
    "At SettleTop (CodeRoot.ai), we don’t replace your tools — we make them stronger. We partner with the leading AI-assisted platforms to bring provenance, trust, and governance to every stage of AI development.",
  pathTitle: "Choose Your AI Path",
  paths: [
    { name: "Create", body: "Audit trail for AI-assisted development, creation and modification." },
    { name: "Test", body: "Context-based vulnerabilities, coverage and fixes based on origin." },
    { name: "Deliver", body: "Continuous provenance across builds and dependencies." },
    { name: "Govern", body: "Automated proof of compliance and governance." },
  ],
  neutral:
    "SettleTop provides a neutral provenance platform focused on empowering your AI tools, solutions and services — we give you more transparency, context and trust.",
  ctaTitle: "Ready to Partner with SettleTop?",
  ctaBody: "Tell us a bit about yourself and how you’d like to work with us.",
  ctaLabel: "Apply to Become a Partner",
  ctaHref: "https://www.settletop.com/partnership-inquiry",
} as const;

export type NewsItem = {
  date: string;
  categories: string[];
  title: string;
  slug: string;
};

export const NEWS: NewsItem[] = [
  {
    date: "12/9/25",
    categories: [],
    title: "Measuring ROI in the Age of AI-Assisted Software Development",
    slug: "measuring-roi-in-the-age-of-ai-assisted-software-development",
  },
  {
    date: "9/29/25",
    categories: [],
    title:
      "SettleTop Launches CodeRoot: A Breakthrough Software Provenance Platform for AI-Assisted Code",
    slug: "settletop-launches-coderoot-a-breakthrough-software-provenance-platform-for-ai-assisted-code",
  },
  {
    date: "9/6/25",
    categories: [],
    title: "Software Provenance in AI-Assisted Code",
    slug: "software-provenance-in-the-ai-era",
  },
  {
    date: "12/21/24",
    categories: [],
    title: "The Rise of AI-Generated Code - Opportunities and Challenges",
    slug: "the-rise-of-ai-generated-code-opportunities-and-challenges",
  },
  {
    date: "12/6/24",
    categories: [],
    title: "The Growing Role of Open Source Program (OSPOs) in Organizations",
    slug: "the-growing-role-of-open-source-program-ospos-in-organizations",
  },
  {
    date: "9/26/24",
    categories: [],
    title:
      "SettleTop Report Finds that Only 5% of Organizations have a Dedicated Senior Software Risk Leader that Reports to Top Management",
    slug: "settletop-report-finds-that-only-5-of-organizations-have-a-dedicated-senior-software-risk-leader-that-reports-to-top-management",
  },
  {
    date: "8/4/24",
    categories: ["SBOM"],
    title:
      "SettleTop to Showcase its SBOM Vendor Management Solution at CISA’s SBOM-a-Rama",
    slug: "settletop-to-showcase-its-sbom-vendor-management-solution-at-cisas-sbom-a-rama",
  },
  {
    date: "7/31/24",
    categories: ["Insights", "Software Supply Chain Risk"],
    title:
      "Understanding the Software Contributors in Open Source Software for Greater Security",
    slug: "understanding-the-software-contributors-in-open-source-software-for-greater-security",
  },
  {
    date: "7/5/24",
    categories: ["Insights", "Software Bill of Materials (SBOM)"],
    title: "The Security Risk of AI and the Important Role of AI/ML BOMs",
    slug: "the-security-risk-of-ai-and-the-important-role-of-aiml-boms",
  },
  {
    date: "2/23/24",
    categories: ["Insights", "Software Supply Chain Risk"],
    title:
      "The Key to Unlocking Government Contracts for Software Vendors in the Current Cybersecurity Landscape",
    slug: "the-key-to-unlocking-government-contracts-for-software-vendors-in-the-current-cybersecurity-landscape",
  },
  {
    date: "1/29/24",
    categories: ["Insights", "SBOM"],
    title:
      "SBOM Vendor Management vs. SBOM Management - is there a difference? Absolutely",
    slug: "the-distinction-betweennbspsbom-managementnbspandnbspsbom-vendor-management-solutions",
  },
  {
    date: "7/24/23",
    categories: ["Press Release"],
    title:
      "SettleTop Awarded a U.S. Air Force $1.25M SBIR Phase II Contract to secure the Nation’s Software Supply Chain",
    // Not a typo: this release is published under a Montgomery IT Summit slug.
    slug: "settletop-to-present-at-us-air-force-montgomery-it-summit-2023-about-sbom-and-cicd-automation-jnr65",
  },
  {
    date: "5/24/23",
    categories: ["Press Release"],
    title:
      "SettleTop Support US Air Force Business Enterprise Systems (BES) with SBOM and Software Code Scanning Dashboard",
    slug: "settletop-support-us-air-force-business-enterprise-systems-bes-with-sbom-and-software-code-scanning",
  },
  {
    date: "5/10/23",
    categories: ["Press Release"],
    title:
      "SettleTop to Present at U.S. Air Force Montgomery IT Summit 2023 about SBOM and CI/CD Automation",
    slug: "settletop-to-present-at-us-air-force-montgomery-it-summit-2023-about-sbom-and-cicd-automation",
  },
  {
    date: "8/26/22",
    categories: ["Insights", "SBOM"],
    title:
      "Understanding Software Bill of Materials (SBOM) standards: CycloneDX, SPDX, SWID",
    slug: "understanding-sbom-standards-cyclonedx-spdx-swid",
  },
  {
    date: "3/18/22",
    categories: ["Insights"],
    title: "Software Bill of Materials (SBOMs) for Supply Chain Risk Management",
    slug: "software-bill-of-materials-sboms-for-supply-chain-risk-management",
  },
  {
    date: "8/20/21",
    categories: ["Insights"],
    title: "Securing the software supply chain is a multi-dimensional challenge",
    slug: "securingthesoftwaresupplychainisamultidimensionalchallenge",
  },
  {
    date: "4/13/21",
    categories: ["Press Release"],
    title:
      "SettleTop Awarded U.S. Air Force SBIR Phase 1 Contract to Secure Software Chain of Authenticity",
    slug: "settletop-awarded-us-air-force-sbir-phase-1-contract-to-secure-software-chain-of-authenticity",
  },
  {
    date: "2/5/21",
    categories: ["Press Release"],
    title:
      "SettleTop Awarded U.S. Air Force SBIR Phase 1 Contract to Secure Software Assets via Blockchain Digital Ledger",
    slug: "settletop-awarded-us-air-force-sbir-phase-1-contract-to-secure-software-assets-via-blockchain-digital-ledger",
  },
  {
    date: "6/1/20",
    categories: ["Press Release"],
    title:
      "SettleTop and Alaska Northstar Resources Awarded a U.S. Air Force Contract for Software Quality Scanning for Cloud One",
    slug: "settletop-and-alaska-northstar-resources-awarded-a-contract-with-the-us-air-force-for-software-quality-scanning",
  },
];
