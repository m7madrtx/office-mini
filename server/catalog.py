"""Divisions, specialties and seniority levels of an IT software / SaaS company."""

DIVISIONS = [
    {"id": "executive", "name": {"en": "Executive", "ar": "الإدارة التنفيذية"}, "color": "#F5B544", "icon": "crown"},
    {"id": "product", "name": {"en": "Product", "ar": "المنتج"}, "color": "#8B7CFF", "icon": "compass"},
    {"id": "engineering", "name": {"en": "Engineering", "ar": "الهندسة"}, "color": "#4F8CFF", "icon": "code"},
    {"id": "research", "name": {"en": "Research & Development", "ar": "البحث والتطوير"}, "color": "#22C3EE", "icon": "flask"},
    {"id": "design", "name": {"en": "Design", "ar": "التصميم"}, "color": "#EC4899", "icon": "pen"},
    {"id": "marketing", "name": {"en": "Marketing", "ar": "التسويق"}, "color": "#FB923C", "icon": "megaphone"},
    {"id": "sales", "name": {"en": "Sales & Success", "ar": "المبيعات ونجاح العملاء"}, "color": "#2EE59D", "icon": "trending"},
    {"id": "operations", "name": {"en": "Operations", "ar": "العمليات"}, "color": "#14B8A6", "icon": "cog"},
]

# Ranks are kept deliberately simple: a team lead directs and delegates, a team member does the work.
LEAD, MEMBER = 2, 4
SENIORITY = [
    {"level": 0, "name": {"en": "Executive", "ar": "تنفيذي"}},
    {"level": LEAD, "name": {"en": "Team lead", "ar": "قائد فريق"}},
    {"level": MEMBER, "name": {"en": "Team member", "ar": "عضو فريق"}},
]

# id, division, English title, Arabic title, tool groups, expertise (used in the agent's system prompt)
_SPECS = [
    ("general_manager", "executive", "General Manager", "المدير العام", ["org"],
     "Runs the whole company. Turns the owner's goals into priorities, breaks them into work, assigns it to the right "
     "managers, follows up, and gives the owner clear decisions with trade-offs. Thinks in outcomes, risk and cost."),
    ("email_manager", "operations", "Email Manager", "مدير الإيميلات", ["email"],
     "Owns the owner's inbox. Triages mail by urgency and importance, summarises threads in a sentence, flags deadlines "
     "and money, and drafts replies in the owner's voice that are short, polite and specific."),
    ("project_manager", "product", "Project Manager", "مدير المشاريع", [],
     "Plans and runs delivery: scope, milestones, timelines, RACI, risk registers, dependencies and status reports. "
     "Fluent in Agile/Scrum and Kanban; turns vague requests into sequenced, estimated work."),
    ("product_manager", "product", "Product Manager", "مدير المنتج", [],
     "Owns what gets built and why: customer problems, PRDs, user stories with acceptance criteria, prioritisation "
     "(RICE/MoSCoW), roadmaps and success metrics for SaaS products."),
    ("engineering_manager", "engineering", "Engineering Manager", "مدير الهندسة", [],
     "Leads engineers: technical planning, estimates, code-review standards, architecture decisions with the team, "
     "and unblocking people. Balances speed, quality and tech debt."),
    ("software_architect", "engineering", "Software Architect", "مهندس معماري للبرمجيات", [],
     "Designs systems: service boundaries, data models, APIs, scalability, multi-tenancy, cloud architecture "
     "(AWS/GCP/Azure) and clear trade-off write-ups with diagrams described in text."),
    ("frontend_engineer", "engineering", "Frontend Engineer", "مهندس واجهات أمامية", [],
     "Builds web UIs with React, TypeScript and modern CSS. Strong on accessibility, performance, state management "
     "and component design. Writes production-quality code."),
    ("backend_engineer", "engineering", "Backend Engineer", "مهندس أنظمة خلفية", [],
     "Builds APIs and services in Python, Node.js or Go with PostgreSQL/Redis. Strong on data modelling, auth, "
     "security, background jobs and testing. Writes production-quality code."),
    ("fullstack_engineer", "engineering", "Full-stack Engineer", "مهندس برمجيات متكامل", [],
     "Ships features end to end: React frontend, API, database and deployment. Pragmatic and fast, "
     "writes clean, tested code."),
    ("mobile_engineer", "engineering", "Mobile Engineer", "مهندس تطبيقات جوال", [],
     "Builds iOS and Android apps with Swift, Kotlin, React Native or Flutter. Knows app-store rules, "
     "offline sync, push notifications and mobile performance."),
    ("devops_engineer", "engineering", "DevOps Engineer", "مهندس DevOps", [],
     "Owns CI/CD, Docker, Kubernetes, infrastructure as code (Terraform), monitoring, cost control and reliability "
     "(SLOs, incident response)."),
    ("qa_engineer", "engineering", "QA Engineer", "مهندس ضمان الجودة", [],
     "Writes test plans and test cases, automates tests (Playwright, pytest), finds edge cases, and files "
     "crisp bug reports with steps to reproduce."),
    ("security_engineer", "engineering", "Security Engineer", "مهندس أمن معلومات", [],
     "Threat models, reviews code for OWASP Top 10 issues, hardens cloud setups, and prepares for SOC 2 / ISO 27001 "
     "and GDPR requirements."),
    ("ml_engineer", "engineering", "AI/ML Engineer", "مهندس ذكاء اصطناعي", [],
     "Builds LLM features: prompt design, RAG, embeddings, evaluation, fine-tuning trade-offs, and model cost/latency."),
    ("rd_researcher", "research", "R&D Researcher", "باحث بحث وتطوير", [],
     "Investigates new technologies and approaches, runs feasibility studies, reviews literature and open-source "
     "projects, and recommends what to prototype with evidence and risks."),
    ("competitor_researcher", "research", "Competitor Researcher", "باحث منافسين", [],
     "Competitive intelligence for SaaS: maps competitors, features, pricing and positioning, writes feature "
     "matrices and SWOT analyses, and spots gaps to exploit. States clearly what is known vs assumed."),
    ("data_analyst", "research", "Data Analyst", "محلل بيانات", [],
     "Defines metrics and dashboards, writes SQL, analyses funnels, cohorts and retention, and explains findings "
     "in plain language with recommended actions."),
    ("ux_researcher", "design", "UX Researcher", "باحث تجربة المستخدم", [],
     "Plans user interviews and usability tests, writes scripts and surveys, builds personas and journey maps, "
     "and turns findings into prioritised insights."),
    ("ui_designer", "design", "UI/UX Designer", "مصمم واجهات وتجربة مستخدم", [],
     "Designs flows, wireframes and high-fidelity UI described precisely in text (layout, spacing, type, colour, "
     "states), and maintains a design system."),
    ("technical_writer", "design", "Technical Writer", "كاتب تقني", [],
     "Writes developer docs, API references, help-centre articles, release notes and onboarding guides that are "
     "clear and well structured."),
    ("marketing_manager", "marketing", "Marketing Manager", "مدير التسويق", [],
     "Owns positioning, messaging, go-to-market plans, campaigns and budgets for B2B/B2C SaaS, with measurable goals."),
    ("content_marketer", "marketing", "Content Marketer", "مسوّق محتوى", [],
     "Writes blog posts, landing pages, social posts, newsletters and case studies with a clear voice and strong hooks."),
    ("seo_specialist", "marketing", "SEO Specialist", "أخصائي تحسين محركات البحث", [],
     "Keyword research, on-page and technical SEO, content briefs, internal linking and search-intent analysis."),
    ("growth_marketer", "marketing", "Growth Marketer", "مسوّق نمو", [],
     "Designs acquisition and activation experiments, landing-page tests, onboarding emails, referral loops and "
     "paid-channel plans with clear success metrics."),
    ("sales_executive", "sales", "Sales Executive", "تنفيذي مبيعات", [],
     "Prospecting, outreach sequences, discovery calls, demos, proposals and objection handling for SaaS deals."),
    ("customer_success", "sales", "Customer Success Manager", "مدير نجاح العملاء", [],
     "Onboarding plans, health scores, renewals, churn prevention, upsell playbooks and QBR decks."),
    ("support_specialist", "sales", "Support Specialist", "أخصائي دعم فني", [],
     "Answers customer tickets clearly and kindly, writes macros and FAQ entries, and escalates bugs with full detail."),
    ("finance_analyst", "operations", "Finance Analyst", "محلل مالي", [],
     "SaaS finance: budgets, pricing models, MRR/ARR, CAC, LTV, burn and runway, and unit-economics analysis."),
    ("hr_recruiter", "operations", "HR & Recruiter", "موارد بشرية وتوظيف", [],
     "Writes job descriptions, hiring plans, interview kits and onboarding checklists, and drafts people policies."),
    ("legal_counsel", "operations", "Legal & Compliance", "الشؤون القانونية والامتثال", [],
     "Drafts and reviews terms of service, privacy policies, DPAs and contracts, and flags GDPR/compliance risks. "
     "Always notes that output is not a substitute for a licensed lawyer."),
]

# Model capabilities each specialty benefits from (used to suggest models). "tools" is always required.
NEEDS = {
    "general_manager": ["reasoning", "multilingual", "long_context"],
    "email_manager": ["multilingual", "ocr"],
    "project_manager": ["reasoning", "long_context"],
    "product_manager": ["reasoning", "multilingual"],
    "engineering_manager": ["coding", "reasoning"],
    "software_architect": ["coding", "reasoning", "long_context"],
    "frontend_engineer": ["coding", "vision"],
    "backend_engineer": ["coding", "reasoning"],
    "fullstack_engineer": ["coding", "vision"],
    "mobile_engineer": ["coding", "vision"],
    "devops_engineer": ["coding", "reasoning"],
    "qa_engineer": ["coding", "vision"],
    "security_engineer": ["coding", "reasoning"],
    "ml_engineer": ["coding", "reasoning", "long_context"],
    "rd_researcher": ["reasoning", "long_context", "multilingual"],
    "competitor_researcher": ["reasoning", "long_context", "multilingual"],
    "data_analyst": ["coding", "reasoning", "vision"],
    "ux_researcher": ["vision", "multilingual", "audio"],
    "ui_designer": ["vision", "ocr"],
    "technical_writer": ["multilingual", "long_context"],
    "marketing_manager": ["multilingual", "reasoning"],
    "content_marketer": ["multilingual", "vision"],
    "seo_specialist": ["multilingual", "long_context"],
    "growth_marketer": ["reasoning", "multilingual"],
    "sales_executive": ["multilingual"],
    "customer_success": ["multilingual", "audio"],
    "support_specialist": ["multilingual", "ocr", "audio"],
    "finance_analyst": ["reasoning", "ocr", "coding"],
    "hr_recruiter": ["multilingual", "ocr"],
    "legal_counsel": ["reasoning", "long_context", "ocr"],
}

SPECIALTIES = {
    sid: {"id": sid, "division": div, "title": {"en": en, "ar": ar}, "tools": tools, "expertise": exp,
          "needs": NEEDS.get(sid, ["reasoning"])}
    for sid, div, en, ar, tools, exp in _SPECS
}

# A curated palette for people and rooms
PALETTE = ["#8B7CFF", "#4F8CFF", "#22C3EE", "#14B8A6", "#2EE59D", "#A3E635", "#F5B544", "#FB923C",
           "#FF5C7A", "#EC4899", "#C084FC", "#F4F4F6", "#94A3B8", "#B08968", "#38BDF8", "#E879F9"]

FIRST_NAMES = ["Khalid", "Mariam", "Omar", "Lina", "Yousef", "Noura", "Faisal", "Huda", "Ahmed", "Sara", "Tariq",
               "Dana", "Hamad", "Reem", "Salem", "Aisha", "Nasser", "Hessa", "Ali", "Fatima", "Adam", "Maya",
               "Leo", "Zara", "Ethan", "Nina", "Ravi", "Mei", "Diego", "Sofia", "Jonas", "Amara", "Kenji",
               "Elif", "Hugo", "Ines", "Samir", "Laila", "Rami", "Yara", "Bader", "Shahad", "Mishal", "Jana"]
LAST_NAMES = ["Al-Rashid", "Haddad", "Al-Mutairi", "Khoury", "Al-Sabah", "Nasser", "Saleh", "Mansour", "Al-Enezi",
              "Farouk", "Kim", "Novak", "Silva", "Okafor", "Tanaka", "Larsen", "Moreau", "Patel", "Rossi", "Weber",
              "Al-Hajri", "Darwish", "Hakimi", "Zayed"]

def rank(value) -> int:
    """Two ranks only: Team lead (2) or Team member (4). 0 is reserved for the General Manager."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return MEMBER
    return LEAD if v <= LEAD else MEMBER


def title_for(specialty: str, seniority: int) -> dict:
    """Job titles are just the specialty ("Backend Engineer"); the rank is shown separately."""
    spec = SPECIALTIES.get(specialty) or SPECIALTIES["fullstack_engineer"]
    return {"en": spec["title"]["en"], "ar": spec["title"]["ar"]}


def public() -> dict:
    return {
        "divisions": DIVISIONS,
        "seniority": SENIORITY,
        "specialties": [{k: v for k, v in s.items() if k != "expertise"} for s in SPECIALTIES.values()],
        "palette": PALETTE,
        "first_names": FIRST_NAMES,
        "last_names": LAST_NAMES,
    }
