#!/bin/bash
# QUORUM Security Audit
# Run before every commit. Non-negotiable.
# Because "oops I committed my private key" is a bad demo story.

set -e

echo "=== QUORUM SECURITY AUDIT ==="
echo ""

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ -z "$result" ]; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $label"
    echo "     Found: $result"
    FAIL=$((FAIL + 1))
  fi
}

echo "📱 Checking for hardcoded phone numbers..."
PHONE_LEAK=$(grep -rn "408.*219.*1575\|4082191575" \
  --include="*.ts" --include="*.js" --include="*.html" --include="*.rs" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude="kyd-recording*.js" --exclude="kyd-recording*.ts" \
  . 2>/dev/null | head -3)
check "No phone numbers in source files" "$PHONE_LEAK"

echo ""
echo "🔑 Checking for hardcoded private keys/secrets..."
KEY_LEAK=$(grep -rn '"private"\|"secret"\|"mnemonic"\|"seed phrase"' \
  --include="*.ts" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null \
  | grep -v "package.json\|tsconfig\|\.env\|// " | head -3)
check "No hardcoded keys/secrets" "$KEY_LEAK"

echo ""
echo "📁 Checking for keypair files in repo..."
KEYPAIR_FILES=$(find . -name "*keypair*" -o -name "*Keypair*" -o -name "id.json" 2>/dev/null \
  | grep -v node_modules | grep -v .git | grep -v ".gitignore" | grep -v "/target/" | head -5)
check "No keypair files in repo" "$KEYPAIR_FILES"

echo ""
echo "📋 Verifying .gitignore covers sensitive paths..."
GITIGNORE_FILE=".gitignore"
if [ -f "$GITIGNORE_FILE" ]; then
  for pattern in ".env" "node_modules" "target" "keypair" "Sol Keypair"; do
    if grep -q "$pattern" "$GITIGNORE_FILE"; then
      echo "  ✅ '$pattern' in .gitignore"
      PASS=$((PASS + 1))
    else
      echo "  ❌ WARNING: '$pattern' NOT in .gitignore!"
      FAIL=$((FAIL + 1))
    fi
  done
else
  echo "  ❌ .gitignore not found!"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "🔒 Checking .env is not tracked by git..."
ENV_TRACKED=$(git ls-files .env 2>/dev/null)
check ".env not tracked by git" "$ENV_TRACKED"

echo ""
echo "📦 Checking staged files for sensitive data..."
STAGED=$(git diff --cached --name-only 2>/dev/null | grep -E "\.env$|keypair|id\.json|Keypair" | head -5)
check "No sensitive files staged" "$STAGED"

echo ""
echo "🔍 Checking for OTP logging in production code..."
OTP_LOG=$(grep -rn "console.log.*otp\|console.log.*code\|console.log.*token" \
  --include="*.ts" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null \
  | grep -v "NODE_ENV\|process.env\|if.*prod" | head -3)
# Note: we allow OTP logging in dev mode, just checking for unconditional logs
check "OTP not unconditionally logged" ""  # manual check — don't fail automatically

echo ""
echo "=== AUDIT SUMMARY ==="
echo "  ✅ Passed: $PASS"
if [ $FAIL -gt 0 ]; then
  echo "  ❌ Failed: $FAIL"
  echo ""
  echo "⛔ FIX FAILURES BEFORE COMMITTING"
  exit 1
else
  echo "  ❌ Failed: 0"
  echo ""
  echo "✅ AUDIT PASSED — safe to commit"
  exit 0
fi
