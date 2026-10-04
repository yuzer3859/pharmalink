# PharmaLink Ethiopia — Risk Analysis

**Document Type:** Risk Analysis & Mitigation Plan
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose
This document identifies risks that could threaten the platform's objectives, assesses their likelihood and impact, and defines mitigation and contingency actions with owners. Risks span regulatory, technical, operational, financial, market, and safety domains.

## 2. Risk Scoring
- **Likelihood (L):** 1 (Rare) – 5 (Almost Certain)
- **Impact (I):** 1 (Negligible) – 5 (Severe)
- **Risk Score = L x I** (1–25). Rating: **Low** (1–6), **Medium** (7–12), **High** (13–19), **Critical** (20–25).

## 3. Risk Register

| ID | Risk | Category | L | I | Score | Rating | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R01 | Regulatory approval for online Rx sales delayed or denied | Regulatory | 4 | 5 | 20 | Critical | Early regulator engagement; phased launch starting with OTC; compliance-by-design; legal counsel | Compliance Lead |
| R02 | Sale of counterfeit or substandard medicines | Safety | 3 | 5 | 15 | High | Strict license verification; source traceability; audits; report-and-suspend workflow | Compliance Lead |
| R03 | Controlled-substance misuse via platform | Safety/Regulatory | 3 | 5 | 15 | High | Exclude/strictly control per regulation; limits; audit; identity checks | Compliance Lead |
| R04 | Data breach of PII / health records | Security | 3 | 5 | 15 | High | Encryption, RBAC, pen testing, monitoring, incident response plan | Security Lead |
| R05 | Low pharmacy/provider adoption | Market | 3 | 4 | 12 | Medium | Onboarding incentives, training, low-friction tools, revenue visibility | Partnerships Lead |
| R06 | Low customer trust/adoption | Market | 3 | 4 | 12 | Medium | Verified badges, ratings, transparent pricing, strong support, marketing | Product/Marketing |
| R07 | Payment provider integration or reliability issues | Technical | 3 | 4 | 12 | Medium | Multiple providers, reconciliation, retries, fallback methods | Engineering Lead |
| R08 | Fayda ID integration unavailable/limited | Technical/Dependency | 3 | 4 | 12 | Medium | Alternate KYC fallback; phased identity requirements | Engineering Lead |
| R09 | Delivery unreliability (coverage, time, spoilage) | Operational | 4 | 3 | 12 | Medium | Partner vetting, SLAs, cold-chain flags, zone-based coverage | Operations Lead |
| R10 | Prescription fraud / forged uploads | Safety/Fraud | 3 | 4 | 12 | Medium | Pharmacist verification, anomaly detection, audit trail | Compliance Lead |
| R11 | Poor connectivity limits usage in regions | Technical/Market | 4 | 3 | 12 | Medium | Lightweight app, offline-tolerant flows, SMS fallback | Engineering Lead |
| R12 | Scalability failures under peak demand | Technical | 2 | 4 | 8 | Medium | Auto-scaling, load testing, capacity planning | Engineering Lead |
| R13 | Cross-border payment/currency friction (diaspora) | Financial | 3 | 3 | 9 | Medium | Supported international methods, clear FX handling | Finance Lead |
| R14 | Provider license expiry causing illegal sales | Compliance | 3 | 4 | 12 | Medium | Automated expiry tracking and auto-suspension | Compliance Lead |
| R15 | Disputes/refund abuse | Financial/Operational | 3 | 3 | 9 | Medium | Clear policies, evidence capture, admin tooling | Operations Lead |
| R16 | Inaccurate inventory causing failed orders | Operational | 4 | 3 | 12 | Medium | Real-time stock sync, re-match logic, penalties for chronic errors | Product Lead |
| R17 | Key-person / talent dependency | Organizational | 3 | 3 | 9 | Medium | Documentation, cross-training, redundancy | CTO |
| R18 | Funding shortfall impacting roadmap | Financial | 3 | 4 | 12 | Medium | Phased MVP, clear KPIs, investor reporting, cost control | CEO/Finance |
| R19 | Competitive entrants | Market | 3 | 3 | 9 | Medium | Speed to market, network effects, provider exclusivity, quality | Product Lead |
| R20 | Third-party service outages (maps/SMS/payment) | Dependency | 3 | 3 | 9 | Medium | Redundant providers, graceful degradation, status monitoring | Engineering Lead |
| R21 | Non-compliance with data-protection law | Regulatory | 3 | 5 | 15 | High | Privacy-by-design, consent, DPO oversight, audits | Compliance/Legal |
| R22 | Reputational damage from safety/quality incident | Reputational | 3 | 5 | 15 | High | Rigorous QA, rapid incident response, transparent comms | CEO/PR |

## 4. Top Risks — Detailed Response Plans

### R01 — Regulatory approval for online Rx sales
- **Trigger indicators:** Regulator feedback, policy delays.
- **Preventive:** Engage EFDA/MoH early; co-design compliance controls; pilot under supervision.
- **Contingency:** Launch OTC-only and healthcare-service modules first; enable Rx upon approval.

### R02 — Counterfeit/substandard medicines
- **Preventive:** Only verified licensed pharmacies; source documentation; periodic audits.
- **Detective:** Customer reporting, batch checks, anomaly monitoring.
- **Contingency:** Immediate suspension, recall notice, regulator notification.

### R04 / R21 — Data breach & data-protection compliance
- **Preventive:** Encryption in transit/at rest, RBAC, least privilege, secure SDLC, pen testing.
- **Detective:** SIEM, alerting, audit logs.
- **Contingency:** Incident response plan, breach notification, forensic review, remediation.

### R09 / R16 — Delivery reliability & inventory accuracy
- **Preventive:** Partner vetting/SLAs, real-time stock sync, cold-chain flags.
- **Contingency:** Re-match, refund policy, provider performance penalties.

## 5. Risk Monitoring & Governance
- Maintain a living risk register reviewed at least monthly and at each phase gate.
- Track leading indicators (compliance rate, breach attempts, delivery SLA, dispute rate, adoption).
- Assign each risk an owner accountable for mitigation status.
- Escalate any risk reaching **High/Critical** to the steering committee.

## 6. Assumptions Impacting Risk
- Regulatory cooperation is achievable with proactive engagement.
- Reliable third-party identity and payment services are available.
- Providers are willing to meet verification and data-accuracy obligations.
