# PharmaLink Ethiopia — Non-Functional Requirements (NFR)

**Document Type:** Non-Functional Requirements Specification
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose
This document specifies quality attributes and constraints the platform must satisfy. Each NFR is measurable and verifiable. NFRs are critical because the platform handles health data, payments, and safety-sensitive workflows.

## 2. Performance (NFR-PERF)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-PERF-01 | Search results shall return quickly under normal load. | <= 2 seconds (95th percentile) |
| NFR-PERF-02 | Page/screen load on 3G mobile networks shall remain usable. | <= 4 seconds first meaningful content |
| NFR-PERF-03 | Payment authorization round-trip shall complete promptly. | <= 5 seconds excluding provider latency |
| NFR-PERF-04 | Real-time delivery tracking updates shall refresh frequently. | <= 10 seconds update interval |
| NFR-PERF-05 | The system shall support concurrent users at launch scale. | >= 10,000 concurrent users |

## 3. Scalability (NFR-SCAL)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-SCAL-01 | The system shall scale horizontally to meet demand. | Auto-scale on load |
| NFR-SCAL-02 | The architecture shall support growth without redesign. | Up to 5M registered users |
| NFR-SCAL-03 | The system shall handle peak order volumes (campaigns, outbreaks). | 10x baseline peak |

## 4. Availability & Reliability (NFR-AVAIL)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-AVAIL-01 | The platform shall maintain high uptime. | >= 99.9% monthly |
| NFR-AVAIL-02 | Critical services (orders, payments) shall have no single point of failure. | Redundant deployment |
| NFR-AVAIL-03 | The system shall recover from failures within a defined RTO. | RTO <= 1 hour |
| NFR-AVAIL-04 | Data loss on failure shall be bounded by a defined RPO. | RPO <= 15 minutes |
| NFR-AVAIL-05 | Planned maintenance shall use low-traffic windows with notice. | Advance notice, minimal downtime |

## 5. Security (NFR-SEC)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-SEC-01 | All data in transit shall be encrypted. | TLS 1.2+ |
| NFR-SEC-02 | Sensitive data at rest shall be encrypted. | AES-256 or equivalent |
| NFR-SEC-03 | The system shall enforce role-based access control (RBAC). | Least privilege |
| NFR-SEC-04 | The system shall not store raw card data; use PCI-compliant provider. | PCI DSS via provider |
| NFR-SEC-05 | The system shall protect against OWASP Top 10 vulnerabilities. | Verified by testing |
| NFR-SEC-06 | The system shall support MFA/OTP for sensitive actions. | Enabled |
| NFR-SEC-07 | The system shall log and monitor security events. | Central audit logging |
| NFR-SEC-08 | The system shall undergo periodic security testing. | Pen test before major release |
| NFR-SEC-09 | The system shall enforce strong password and session policies. | Configurable policy |
| NFR-SEC-10 | Prescriptions and health records shall be access-controlled and audited. | Full audit trail |

## 6. Privacy & Data Protection (NFR-PRIV)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-PRIV-01 | The system shall comply with applicable Ethiopian data-protection law. | Compliant |
| NFR-PRIV-02 | The system shall collect only necessary personal/medical data. | Data minimization |
| NFR-PRIV-03 | The system shall obtain user consent for data processing. | Explicit consent |
| NFR-PRIV-04 | The system shall support data access, correction, and deletion requests. | Per policy/SLA |
| NFR-PRIV-05 | The system shall retain health/regulatory records for the required period only. | Policy-driven retention |
| NFR-PRIV-06 | The system shall segregate and protect PII and health data. | Logical/physical separation |

## 7. Usability & Accessibility (NFR-USE)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-USE-01 | The UI shall be intuitive for low-tech-literacy users. | Task success in usability tests |
| NFR-USE-02 | The platform shall support Amharic and English. | Full localization |
| NFR-USE-03 | The UI shall meet accessibility guidelines. | WCAG 2.1 AA |
| NFR-USE-04 | Core tasks shall be completable in minimal steps. | Order in <= 5 steps |
| NFR-USE-05 | The UI shall be responsive across common devices/screen sizes. | Mobile-first |

## 8. Localization & Regional (NFR-LOC)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-LOC-01 | The system shall support Ethiopian currency (ETB) and formats. | ETB, local formats |
| NFR-LOC-02 | The system shall support cross-border currency handling for diaspora. | Multi-currency payment |
| NFR-LOC-03 | The system shall handle Ethiopian address/geolocation conventions. | Supported |
| NFR-LOC-04 | The system shall function under intermittent connectivity. | Graceful degradation/offline-tolerant flows |

## 9. Maintainability & Supportability (NFR-MAINT)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-MAINT-01 | The system shall use modular, well-documented services. | Documented APIs |
| NFR-MAINT-02 | The system shall support CI/CD with automated testing. | Automated pipeline |
| NFR-MAINT-03 | Configuration (fees, zones, limits) shall be changeable without redeploy. | Config-driven |
| NFR-MAINT-04 | The system shall provide centralized logging and monitoring. | Observability stack |
| NFR-MAINT-05 | The system shall support feature flags for safe rollout. | Enabled |

## 10. Compliance & Regulatory (NFR-COMP)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-COMP-01 | Only license-verified pharmacies/providers shall transact. | Enforced |
| NFR-COMP-02 | Rx medicines shall require verified prescriptions before dispensing. | Enforced |
| NFR-COMP-03 | Controlled substances shall follow strict rules or be excluded. | Per regulation |
| NFR-COMP-04 | The system shall maintain auditable records for regulators. | Immutable audit logs |
| NFR-COMP-05 | The system shall support traceability of medicine sourcing where required. | Batch/source tracking (as feasible) |

## 11. Interoperability (NFR-INTEROP)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-INTEROP-01 | The system shall expose secure APIs for integrations. | REST/HTTPS, versioned |
| NFR-INTEROP-02 | The system shall integrate with Fayda ID, payment, mapping, and notification providers. | Documented adapters |
| NFR-INTEROP-03 | The system shall support future insurance and distributor integrations. | Extensible interfaces |

## 12. Auditability & Traceability (NFR-AUDIT)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-AUDIT-01 | Sensitive actions shall be logged with actor, time, and context. | Complete audit trail |
| NFR-AUDIT-02 | Audit logs shall be tamper-evident and retained per policy. | Immutable storage |
| NFR-AUDIT-03 | The system shall support end-to-end order and prescription traceability. | Traceable lifecycle |

## 13. Portability & Environment (NFR-PORT)
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-PORT-01 | The backend shall be cloud-agnostic where feasible. | Containerized |
| NFR-PORT-02 | Mobile apps shall support current Android and iOS versions. | Latest 2 major versions |

## 14. Verification Approach
Each NFR is validated via load/performance testing, security/penetration testing, usability testing, accessibility audits, chaos/failover testing, and compliance review before major releases. NFRs feed directly into the Acceptance Criteria and QA test plans.
