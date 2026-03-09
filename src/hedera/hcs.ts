/**
 * BorealisMark — Hedera Consensus Service Module
 *
 * Lazy-loads @hashgraph/sdk to avoid blocking server startup (~20s import).
 * All SDK classes are loaded on first use via loadSDK().
 */

import type { AuditCertificate, SlashEvent } from '../engine/types';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface HCSConfig {
  accountId: string;
  privateKey: string;
  network: 'testnet' | 'mainnet';
  auditTopicId?: string;
}

export interface HCSSubmitResult {
  topicId: string;
  transactionId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
}

// ─── Lazy SDK Loading ─────────────────────────────────────────────────────────

let _sdk: any = null;

async function loadSDK() {
  if (_sdk) return _sdk;
  const sdk = await import('@hashgraph/sdk');
  _sdk = sdk;
  return sdk;
}

// ─── Key Parsing ──────────────────────────────────────────────────────────────

/**
 * Parses a Hedera private key from any format:
 *   - DER-encoded hex (starts with 302e for ED25519, 3041/302a for ECDSA)
 *   - Raw 64-char hex — treated as ED25519 (default for Hedera portal accounts)
 *   - PEM string
 *
 * Never use fromString() alone — it can mis-detect the algorithm and produce
 * a key that parses without error but fails INVALID_SIGNATURE on the network.
 */
function parsePrivateKey(PrivateKey: any, keyString: string, algorithm?: string) {
  // Strip 0x prefix if present (common in EVM-style key exports)
  const s = keyString.trim().replace(/^0x/, '');
  // DER prefix: 302e = ED25519, 3041 or 302a = ECDSA — format is unambiguous
  if (s.startsWith('302e')) return PrivateKey.fromStringDer(s);
  if (s.startsWith('3041') || s.startsWith('302a')) return PrivateKey.fromStringDer(s);
  if (s.startsWith('-----BEGIN')) return PrivateKey.fromStringDer(s);
  // Raw hex — algorithm is ambiguous from the bytes alone.
  // Use HEDERA_KEY_ALGORITHM env var if set, otherwise default to ED25519.
  // portal.hedera.com uses ED25519 by default; MetaMask/EVM accounts use ECDSA.
  const algo = (algorithm ?? process.env.HEDERA_KEY_ALGORITHM ?? 'ED25519').toUpperCase();
  if (algo === 'ECDSA') return PrivateKey.fromStringECDSA(s);
  return PrivateKey.fromStringED25519(s);
}

// ─── Client Factory ───────────────────────────────────────────────────────────

export async function createHederaClient(config: HCSConfig): Promise<any> {
  const { Client, AccountId, PrivateKey } = await loadSDK();

  const client =
    config.network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();

  client.setOperator(
    AccountId.fromString(config.accountId),
    parsePrivateKey(PrivateKey, config.privateKey),
  );

  return client;
}

// ─── Topic Management ─────────────────────────────────────────────────────────

/**
 * Creates the BorealisMark audit registry topic on Hedera.
 * This should be run once and the resulting topic ID stored in HEDERA_AUDIT_TOPIC_ID.
 * The topic has a submit key so only the BorealisMark operator can write to it.
 */
export async function createAuditTopic(client: any): Promise<string> {
  const { TopicCreateTransaction } = await loadSDK();

  const operatorPublicKey = client.operatorPublicKey;
  if (!operatorPublicKey) {
    throw new Error('Hedera client has no operator key configured');
  }

  const tx = await new TopicCreateTransaction()
    .setTopicMemo('BorealisMark Audit Certificate Registry v1.0.0')
    .setSubmitKey(operatorPublicKey)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  if (!receipt.topicId) {
    throw new Error('Topic creation failed — no topic ID in receipt');
  }

  return receipt.topicId.toString();
}

// ─── Certificate Anchoring ────────────────────────────────────────────────────

/**
 * Submits an audit certificate to Hedera Consensus Service.
 *
 * The message written on-chain is a compact proof:
 *   - certificateId: human-readable identifier
 *   - agentId + score: the public claim
 *   - certificateHash: the cryptographic commitment
 *   - issuedAt: the timestamp BorealisMark generated the cert
 *
 * The full certificate (with all score breakdown details) is stored off-chain
 * in the database. The on-chain record proves the hash commitment was made
 * at a specific consensus timestamp.
 */
export async function submitCertificateToHCS(
  client: any,
  topicId: string,
  certificate: AuditCertificate,
): Promise<HCSSubmitResult> {
  const { TopicMessageSubmitTransaction, TopicId } = await loadSDK();

  const message = JSON.stringify({
    protocol: 'BorealisMark/1.0',
    type: 'AUDIT_CERTIFICATE',
    certificateId: certificate.certificateId,
    agentId: certificate.agentId,
    agentVersion: certificate.agentVersion,
    score: certificate.score.total,
    creditRating: certificate.creditRating,
    certificateHash: certificate.certificateHash,
    inputHash: certificate.inputHash,
    issuedAt: certificate.issuedAt,
  });

  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(message)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const record = await tx.getRecord(client);

  if (!receipt.topicSequenceNumber) {
    throw new Error('HCS submission failed — no sequence number in receipt');
  }

  return {
    topicId,
    transactionId: tx.transactionId.toString(),
    sequenceNumber: receipt.topicSequenceNumber.toNumber(),
    consensusTimestamp: record.consensusTimestamp?.toDate().toISOString() ?? new Date().toISOString(),
  };
}

// ─── Slash Event Anchoring ────────────────────────────────────────────────────

/**
 * Anchors a slashing event on-chain.
 * This creates the immutable record that a violation occurred and stake was
 * redistributed — the enforcement proof.
 */
export async function submitSlashEventToHCS(
  client: any,
  topicId: string,
  slashEvent: SlashEvent,
): Promise<HCSSubmitResult> {
  const { TopicMessageSubmitTransaction, TopicId } = await loadSDK();

  const message = JSON.stringify({
    protocol: 'BorealisMark/1.0',
    type: 'SLASH_EVENT',
    slashId: slashEvent.slashId,
    agentId: slashEvent.agentId,
    violationType: slashEvent.violationType,
    amountSlashed: slashEvent.amountSlashed,
    claimantAddress: slashEvent.claimantAddress,
    executedAt: slashEvent.executedAt,
  });

  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(message)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const record = await tx.getRecord(client);

  return {
    topicId,
    transactionId: tx.transactionId.toString(),
    sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? 0,
    consensusTimestamp: record.consensusTimestamp?.toDate().toISOString() ?? new Date().toISOString(),
  };
}
