# Third-party components

This browser prototype ports the inference computations and report preprocessing used by RadGraph, AllenNLP and DyGIE to JavaScript/ONNX. Preserve the supplied source notices and RadGraph license under `licenses/`. Upstream projects:

- RadGraph: https://github.com/Stanford-AIMI/radgraph
- AllenNLP: https://github.com/allenai/allennlp
- DyGIE++: https://github.com/dwadden/dygiepp

Model origins used by the project:

- ClinicalBERT base: https://huggingface.co/emilyalsentzer/Bio_ClinicalBERT
- RadGraph-XL: https://huggingface.co/StanfordAIMI/RRG_scorers
- RadGraph transformer configuration/tokenizer: https://huggingface.co/microsoft/BiomedVLP-CXR-BERT-general

The two exported ClinicalBERT encoders contain the project's saved encoder states. They are not presented as unmodified upstream checkpoints. Source candidate and exported model hashes are recorded in `assets/manifest.json` and `assets/reports/manifest.json`.

ONNX Runtime Web retains its notices under `runtime/`. This browser site does not include training patient data or grant access to any underlying clinical dataset.
