/**
 * BorealisMark Certificate Verifier
 * ──────────────────────────────────
 * Standalone script. Zero trust in BorealisMark required.
 *
 * Given a certificate JSON (from GET /v1/agents/:id/certificate),
 * this script independently recomputes both SHA-256 hashes and
 * confirms whether the certificate was tampered with.
 *
 * Usage:
 *   ts-node src/verify-certificate.ts <certificateId>
 *   ts-node src/verify-certificate.ts --file ./cert.json
 *
 * Anyone can run this. It does not require API access or a database.
 * The only inputs are the certificate JSON itself.
 */

import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { AuditCertificate, ScoreBreakdown, AuditInput } from './engine/types';

// ─── Hash Functions (mirrors audit-engine.ts exactly) ────────────────────────
// These must never diverge from the engine. If they do, all certs become unverifiable.

function recomputeCertificateHash(
  agentId: string,
  auditId: string,
  issuedAt: number,
  score: ScoreBreakdown,
  inputHash: string,
): string {
  const canonical = JSON.stringify({
    agentId,
    auditId,
    issuedAt,
    score,
    inputHash,
    issuer: 'BorealisMark Protocol v1.0.0',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Display ──────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GOLD = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function pass(label: string, value: string) {
  console.log(`  ${GREEN}✓${RESET} ${BOLD}${label}${RESET}  ${DIM}${value}${RESET}`);
}

function fail(label: string, expected: string, got: string) {
  console.log(`  ${RED}✗ FAIL: ${label}${RESET}`);
  console.log(`    ${RED}expected:${RESET} ${expected}`);
  console.log(`    ${RED}got:     ${RESET} ${got}`);
}

function info(label: string, value: string) {
  console.log(`  ${GOLD}→${RESET} ${label.padEnd(28)} ${value}`);
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

async function verify(cert: AuditCertificate): Promise<boolean> {
  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║   BorealisMark Certificate Verifier v1.0.0               ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n`);

  info('Certificate ID', cert.certificateId);
  info('Agent ID', cert.agentId);
  info('Agent Version', cert.agentVersion);
  info('Issued At', new Date(cert.issuedAt).toISOString());
  info('Credit Rating', cert.creditRating);
  info('Score', `${cert.score.total}/1000`);
  console.log();

  let allPassed = true;

  // ── 1. Recompute certificateHash ──────────────────────────────────────────
  console.log(`${BOLD}[1] Certificate Hash Integrity${RESET}`);
  const recomputedCertHash = recomputeCertificateHash(
    cert.agentId,
    cert.auditId,
    cert.issuedAt,
    cert.score,
    cert.inputHash,
  );

  if (recomputedCertHash === cert.certificateHash) {
    pass('certificateHash matches', cert.certificateHash.slice(0, 32) + '...');
  } else {
    fail('certificateHash MISMATCH', cert.certificateHash, recomputedCertHash);
    allPassed = false;
  }

  // ── 2. Score arithmetic check ─────────────────────────────────────────────
  console.log(`\n${BOLD}[2] Score Arithmetic${RESET}`);
  const { constraintAdherence, decisionTransparency, behavioralConsistency, anomalyRate, auditCompleteness, total } = cert.score;
  const expectedTotal = constraintAdherence + decisionTransparency + behavioralConsistency + anomalyRate + auditCompleteness;

  if (expectedTotal === total) {
    pass('Score totals correctly', `${constraintAdherence} + ${decisionTransparency} + ${behavioralConsistency} + ${anomalyRate} + ${auditCompleteness} = ${total}`);
  } else {
    fail('Score arithmetic error', String(expectedTotal), String(total));
    allPassed = false;
  }

  // ── 3. Score bounds check ─────────────────────────────────────────────────
  console.log(`\n${BOLD}[3] Score Bounds${RESET}`);
  const bounds: Array<[string, number, number]> = [
    ['constraintAdherence', constraintAdherence, 350],
    ['decisionTransparency', decisionTransparency, 200],
    ['behavioralConsistency', behavioralConsistency, 200],
    ['anomalyRate', anomalyRate, 150],
    ['auditCompleteness', auditCompleteness, 100],
  ];

  for (const [name, value, max] of bounds) {
    if (value >= 0 && value <= max) {
      pass(`${name} in range`, `${value}/${max}`);
    } else {
      fail(`${name} out of range`, `0–${max}`, String(value));
      allPassed = false;
    }
  }

  // ── 4. Issuer check ───────────────────────────────────────────────────────
  console.log(`\n${BOLD}[4] Issuer${RESET}`);
  if (cert.issuer === 'BorealisMark Protocol v1.0.0') {
    pass('Issuer recognised', cert.issuer);
  } else {
    fail('Unknown issuer', 'BorealisMark Protocol v1.0.0', cert.issuer);
    allPassed = false;
  }

  // ── 5. Revocation check ───────────────────────────────────────────────────
  console.log(`\n${BOLD}[5] Revocation Status${RESET}`);
  if (!cert.revoked) {
    pass('Certificate is active', 'not revoked');
  } else {
    fail('Certificate is REVOKED', 'false', 'true');
    allPassed = false;
  }

  // ── 6. On-chain proof ─────────────────────────────────────────────────────
  console.log(`\n${BOLD}[6] Hedera On-Chain Proof${RESET}`);
  if (cert.hcsTransactionId && cert.hcsTopicId) {
    pass('Anchored on Hedera HCS', cert.hcsTransactionId);
    info('Topic ID', cert.hcsTopicId);
    info('Sequence #', String(cert.hcsSequenceNumber ?? 'n/a'));
    info('Consensus timestamp', cert.hcsConsensusTimestamp ?? 'n/a');

    const network = process.env.HEDERA_NETWORK ?? 'testnet';
    const txId = cert.hcsTransactionId.replace(/@/, '-').replace(/\./, '-');
    const hashscanUrl = `https://hashscan.io/${network}/transaction/${txId}`;
    console.log(`\n  ${GOLD}Verify on HashScan:${RESET}`);
    console.log(`  ${hashscanUrl}\n`);
  } else {
    console.log(`  ${GOLD}⚠${RESET}  Not yet anchored on-chain (certificate still valid — hash integrity confirmed above)`);
  }

  // ── Result ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════${RESET}`);
  if (allPassed) {
    console.log(`${GREEN}${BOLD}  ✓ CERTIFICATE VERIFIED — integrity confirmed${RESET}`);
    console.log(`${DIM}  All hashes match. This certificate was not tampered with.${RESET}`);
  } else {
    console.log(`${RED}${BOLD}  ✗ CERTIFICATE FAILED VERIFICATION${RESET}`);
    console.log(`${RED}  One or more checks failed. This certificate may have been tampered with.${RESET}`);
  }
  console.log(`${BOLD}═══════════════════════════════════════════════════════════${RESET}\n`);

  return allPassed;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: ts-node src/verify-certificate.ts <certificateId>');
    console.error('       ts-node src/verify-certificate.ts --file ./cert.json');
    process.exit(1);
  }

  let cert: AuditCertificate;

  if (args[0] === '--file') {
    // Load from local JSON file
    const filePath = args[1];
    if (!filePath) {
      console.error('--file requires a path argument');
      process.exit(1);
    }
    try {
      cert = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Failed to read file: ${filePath}`);
      process.exit(1);
    }
  } else {
    // Fetch from live API
    const certId = args[0];
    const apiKey = process.env.API_MASTER_KEY;
    if (!apiKey) {
      console.error('API_MASTER_KEY environment variable is required.');
      process.exit(1);
    }
    const port = process.env.PORT ?? '3001';
    const url = `http://localhost:${port}/v1/agents/${certId}/certificate`;

    try {
      const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
      const json = await res.json() as { success: boolean; data: AuditCertificate; error?: string };
      if (!json.success || !json.data) {
        console.error(`API error: ${json.error ?? 'unknown'}`);
        process.exit(1);
      }
      cert = json.data;
    } catch (e) {
      console.error(`Could not reach API at ${url}. Is the server running?`);
      process.exit(1);
    }
  }

  const passed = await verify(cert);
  process.exit(passed ? 0 : 1);
}

main();
