# ACLF rolling prognosis research

The website uses the current report-enabled rolling model for both the initial T0 assessment and subsequent daily assessments. The previous fixed-origin model and its explanation page have been removed from the deployed site.

- Default language: English. Use the language button or `?lang=zh` for Chinese.
- Keep the original T0 and select the current assessment time. The primary update range is days 0–14; days 15–28 are exploratory.
- Each assessment estimates death before liver transplant within its own next 28/90 days, with transplant as a competing event.
- Explanation & review computes grouped permutation Shapley contributions for the selected assessment and horizon using the current model. It displays the top 10 groups, all 45 groups with entered evidence, and an exportable HTML explanation report.
- Four artificial no-report reference cases and eight paired permutation paths are used. Admission-to-T0 time and assessment time are held fixed. Contributions describe model behavior rather than causal effects.
- Cases, predictions, explanations and review notes can be exported to a user-owned JSON file. This site has no case database or login. Imported predictions are recalculated before use.

All inference and report encoding run in the visitor browser. Frozen ClinicalBERT-90 and RadGraph-XL assets are downloaded on demand from the pinned public model repository. The rolling risk weights and hashes are in `assets/rolling/manifest.json`. No patient reports, training cases or individual outcome records are shipped with the website.

The prediction model has not been retrained for the explanation update. The model and its reported development metrics remain unchanged. Research use only.
