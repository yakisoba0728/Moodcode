{
  "targets": [{
    "target_name": "windows_job",
    "sources": ["src/windows_job.cc"],
    "defines": ["NAPI_VERSION=8", "NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0A00"],
    "win_delay_load_hook": "true",
    "msvs_settings": {
      "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/W4"], "ExceptionHandling": 1 }
    },
    "conditions": [["OS!='win'", { "type": "none", "sources": [] }]]
  }]
}
