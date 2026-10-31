#!/usr/bin/env bash
# llm-gateway-monitor — Monitor local LLM instances (Ollama, vLLM, etc.)
set -euo pipefail

VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

LLM gateway and inference server monitor. Checks Ollama, vLLM,
text-generation-inference (TGI) endpoints. Reports loaded models,
GPU utilization, inference latency, and model storage usage.

Options:
  -h, --help     Show this help message and exit
  -v             Increase verbosity (repeat for more: -vv, -vvv)

Verbosity levels:
  (default)      Service status, loaded models, GPU summary
  -v             Include model storage, inference latency test
  -vv            Include per-model details, GPU memory breakdown
  -vvv           Full API response dump

Examples:
  $(basename "$0")             # Quick LLM status
  $(basename "$0") -v          # Include latency benchmarks
  $(basename "$0") -vv         # Full LLM infrastructure audit
EOF
  exit 0
}

log_v1() { [[ $VERBOSE -ge 1 ]] && echo "[DEBUG] $*" >&2 || true; }
log_v2() { [[ $VERBOSE -ge 2 ]] && echo "[TRACE] $*" >&2 || true; }
log_v3() { [[ $VERBOSE -ge 3 ]] && echo "[DETAIL] $*" >&2 || true; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    -vvv) VERBOSE=3; shift ;;
    -vv) VERBOSE=2; shift ;;
    -v) VERBOSE=$((VERBOSE + 1)); shift ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) break ;;
  esac
done

# Common LLM service endpoints
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
VLLM_HOST="${VLLM_HOST:-http://localhost:8000}"
TGI_HOST="${TGI_HOST:-http://localhost:8080}"

echo "=== LLM Gateway Monitor ==="

echo "--- Service Discovery ---"
SERVICES_FOUND=0

# Check Ollama
OLLAMA_UP=false
if curl -sf --connect-timeout 3 "${OLLAMA_HOST}/api/version" &>/dev/null; then
  OLLAMA_VERSION=$(curl -sf --connect-timeout 3 "${OLLAMA_HOST}/api/version" 2>/dev/null | grep -oP '"version"\s*:\s*"\K[^"]+' || echo "unknown")
  echo "  ✓ Ollama: running (v${OLLAMA_VERSION}) at ${OLLAMA_HOST}"
  OLLAMA_UP=true
  SERVICES_FOUND=$((SERVICES_FOUND + 1))
else
  echo "  ✗ Ollama: not responding at ${OLLAMA_HOST}"
fi

# Check vLLM
VLLM_UP=false
if curl -sf --connect-timeout 3 "${VLLM_HOST}/health" &>/dev/null || curl -sf --connect-timeout 3 "${VLLM_HOST}/v1/models" &>/dev/null; then
  echo "  ✓ vLLM: running at ${VLLM_HOST}"
  VLLM_UP=true
  SERVICES_FOUND=$((SERVICES_FOUND + 1))
else
  echo "  ✗ vLLM: not responding at ${VLLM_HOST}"
fi

# Check TGI
TGI_UP=false
if curl -sf --connect-timeout 3 "${TGI_HOST}/health" &>/dev/null; then
  echo "  ✓ TGI: running at ${TGI_HOST}"
  TGI_UP=true
  SERVICES_FOUND=$((SERVICES_FOUND + 1))
else
  echo "  ✗ TGI: not responding at ${TGI_HOST}"
fi

echo "  Services found: $SERVICES_FOUND"

# ── Ollama Models ──
if $OLLAMA_UP; then
  echo "--- Ollama Models ---"
  MODELS_JSON=$(curl -sf --connect-timeout 5 "${OLLAMA_HOST}/api/tags" 2>/dev/null || echo "")
  if [[ -n "$MODELS_JSON" ]]; then
    echo "$MODELS_JSON" | grep -oP '"name"\s*:\s*"\K[^"]+' | while read -r model; do
      SIZE=$(echo "$MODELS_JSON" | grep -oP "\"name\"\\s*:\\s*\"${model}\"[^}]*\"size\"\\s*:\\s*\\K[0-9]+" | head -1)
      if [[ -n "$SIZE" ]]; then
        SIZE_GB=$(awk "BEGIN {printf \"%.1f\", $SIZE / 1073741824}")
        echo "  $model (${SIZE_GB} GB)"
      else
        echo "  $model"
      fi
    done
    MODEL_COUNT=$(echo "$MODELS_JSON" | grep -oP '"name"\s*:\s*"' | wc -l)
    echo "  Total models: $MODEL_COUNT"
  else
    echo "  Failed to list models"
  fi

  echo "--- Ollama Running Models ---"
  RUNNING_JSON=$(curl -sf --connect-timeout 5 "${OLLAMA_HOST}/api/ps" 2>/dev/null || echo "")
  if [[ -n "$RUNNING_JSON" ]]; then
    RUNNING=$(echo "$RUNNING_JSON" | grep -oP '"name"\s*:\s*"\K[^"]+')
    if [[ -n "$RUNNING" ]]; then
      echo "$RUNNING" | sed 's/^/  ✓ /'
    else
      echo "  No models currently loaded in memory"
    fi
  else
    echo "  Could not query running models"
  fi
fi

# ── vLLM Models ──
if $VLLM_UP; then
  echo "--- vLLM Models ---"
  VLLM_MODELS=$(curl -sf --connect-timeout 5 "${VLLM_HOST}/v1/models" 2>/dev/null || echo "")
  if [[ -n "$VLLM_MODELS" ]]; then
    echo "$VLLM_MODELS" | grep -oP '"id"\s*:\s*"\K[^"]+' | sed 's/^/  /'
  else
    echo "  Could not query models"
  fi
fi

echo "--- GPU Status ---"
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | while IFS=',' read -r idx name mem_used mem_total util temp; do
    mem_used=$(echo "$mem_used" | tr -d ' ')
    mem_total=$(echo "$mem_total" | tr -d ' ')
    util=$(echo "$util" | tr -d ' ')
    temp=$(echo "$temp" | tr -d ' ')
    MEM_PCT=$((mem_used * 100 / mem_total))
    STATUS="✓"
    [[ $MEM_PCT -ge 90 ]] && STATUS="⚠"
    echo "  GPU $idx ($name): ${mem_used}/${mem_total} MiB (${MEM_PCT}%), util: ${util}%, temp: ${temp}°C $STATUS"
  done
elif command -v rocm-smi &>/dev/null; then
  rocm-smi --showuse --showtemp 2>/dev/null | head -20 | sed 's/^/  /'
else
  echo "  No GPU tools found (nvidia-smi / rocm-smi)"
fi

# ── Storage and latency (verbose 1+) ──
if [[ $VERBOSE -ge 1 ]]; then
  echo "--- Model Storage ---"
  OLLAMA_MODELS_DIR="${OLLAMA_MODELS:-/usr/share/ollama/.ollama/models}"
  [[ -d "$HOME/.ollama/models" ]] && OLLAMA_MODELS_DIR="$HOME/.ollama/models"
  if [[ -d "$OLLAMA_MODELS_DIR" ]]; then
    TOTAL_SIZE=$(du -sh "$OLLAMA_MODELS_DIR" 2>/dev/null | awk '{print $1}')
    echo "  Ollama models dir: $OLLAMA_MODELS_DIR ($TOTAL_SIZE)"
  else
    echo "  Ollama models dir: not found at default locations"
  fi

  # HuggingFace cache
  HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"
  if [[ -d "$HF_CACHE" ]]; then
    HF_SIZE=$(du -sh "$HF_CACHE" 2>/dev/null | awk '{print $1}')
    echo "  HuggingFace cache: $HF_CACHE ($HF_SIZE)"
  fi

  echo "--- Inference Latency Test ---"
  if $OLLAMA_UP; then
    # Pick first available model
    TEST_MODEL=$(curl -sf "${OLLAMA_HOST}/api/tags" 2>/dev/null | grep -oP '"name"\s*:\s*"\K[^"]+' | head -1)
    if [[ -n "$TEST_MODEL" ]]; then
      echo "  Testing with: $TEST_MODEL"
      START=$(date +%s%N)
      RESPONSE=$(curl -sf --connect-timeout 10 -X POST "${OLLAMA_HOST}/api/generate" \
        -H "Content-Type: application/json" \
        -d "{\"model\":\"$TEST_MODEL\",\"prompt\":\"Say hello.\",\"stream\":false,\"options\":{\"num_predict\":10}}" 2>/dev/null || echo "")
      END=$(date +%s%N)
      LATENCY_MS=$(( (END - START) / 1000000 ))
      if [[ -n "$RESPONSE" ]]; then
        EVAL_DURATION=$(echo "$RESPONSE" | grep -oP '"eval_duration"\s*:\s*\K[0-9]+' || echo 0)
        TOKENS=$(echo "$RESPONSE" | grep -oP '"eval_count"\s*:\s*\K[0-9]+' || echo 0)
        if [[ $EVAL_DURATION -gt 0 && $TOKENS -gt 0 ]]; then
          TPS=$(awk "BEGIN {printf \"%.1f\", $TOKENS / ($EVAL_DURATION / 1000000000)}")
          echo "  ✓ Response in ${LATENCY_MS}ms, ${TPS} tokens/sec"
        else
          echo "  ✓ Response in ${LATENCY_MS}ms"
        fi
      else
        echo "  ✗ Inference request failed"
      fi
    else
      echo "  No models available for testing"
    fi
  fi
fi

# ── Detailed model info (verbose 2+) ──
if [[ $VERBOSE -ge 2 ]]; then
  if $OLLAMA_UP; then
    echo "--- Ollama Model Details ---"
    curl -sf "${OLLAMA_HOST}/api/tags" 2>/dev/null | grep -oP '"name"\s*:\s*"\K[^"]+' | while read -r model; do
      INFO=$(curl -sf -X POST "${OLLAMA_HOST}/api/show" -d "{\"name\":\"$model\"}" 2>/dev/null || echo "")
      if [[ -n "$INFO" ]]; then
        PARAMS=$(echo "$INFO" | grep -oP '"parameter_size"\s*:\s*"\K[^"]+' || echo "?")
        QUANT=$(echo "$INFO" | grep -oP '"quantization_level"\s*:\s*"\K[^"]+' || echo "?")
        FAMILY=$(echo "$INFO" | grep -oP '"family"\s*:\s*"\K[^"]+' || echo "?")
        echo "  $model — family: $FAMILY, params: $PARAMS, quant: $QUANT"
      fi
    done
  fi

  echo "--- GPU Memory Breakdown ---"
  if command -v nvidia-smi &>/dev/null; then
    echo "  Top GPU processes:"
    nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null | sed 's/^/    /' || echo "    No compute processes"
  fi
fi

# ── Full dump (verbose 3) ──
if [[ $VERBOSE -ge 3 ]]; then
  echo "--- Ollama Full API Response ---"
  curl -sf "${OLLAMA_HOST}/api/tags" 2>/dev/null | head -100 | sed 's/^/  /' || true

  echo "--- nvidia-smi Full ---"
  nvidia-smi 2>/dev/null | sed 's/^/  /' || echo "  not available"

  echo "--- LLM Process Details ---"
  ps aux 2>/dev/null | grep -iE 'ollama|vllm|text-generation|llama|transformers' | grep -v grep | sed 's/^/  /' || echo "  none"
fi
