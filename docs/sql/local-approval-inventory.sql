-- Run before migration 027. Read-only; no inferred latest-version fallback.
BEGIN TRANSACTION READ ONLY;
SELECT t.key, t.submitted_version,
       (v.template_id IS NOT NULL) AS pin_resolves,
       COALESCE(r.decision = 'approved' AND r.reviewer_user_id <> t.created_by_user_id, false) AS independent_evidence,
       (v.locality_id IS NOT NULL AND v.locality_snapshot IS NOT NULL) AS locality_bound,
       (t.submitted_version IS NULL OR v.template_id IS NULL OR
         t.submitted_version <> (SELECT max(version) FROM hunt_template_versions WHERE template_id=t.id)) AS inconsistent_pin
FROM hunt_templates t
LEFT JOIN hunt_template_versions v ON v.template_id=t.id AND v.version=t.submitted_version
LEFT JOIN hunt_template_reviews r ON r.template_id=t.id AND r.version=t.submitted_version
WHERE t.origin='creator' AND t.category='local' AND t.status='approved'
ORDER BY t.key;
COMMIT;
