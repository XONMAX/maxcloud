/**
 * Seed: plan catalogue + demo data. Idempotent (safe to run repeatedly).
 *   demo@maxcloud.uz   / demo-password-2026   (100 GB plan, folders, sample files, a share link)
 *   admin@maxcloud.uz  / admin-password-2026  (ADMIN role)
 *   family@maxcloud.uz / family-password-2026 (has a folder shared with demo)
 * Sample file bytes are uploaded to the configured bucket so previews work.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { GB, fileKind, getPlan } from '@maxcloud/shared';
import { syncPlans } from '../src/billing/plans.sync';

const prisma = new PrismaClient();
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});
const bucket = process.env.S3_BUCKET!;

async function user(email: string, name: string, password: string, planId: string, role: 'USER' | 'ADMIN' = 'USER') {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      name,
      role,
      planId,
      quotaBytes: BigInt(getPlan(planId).quotaBytes),
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      emailVerifiedAt: new Date(),
    },
  });
}

async function folder(ownerId: string, name: string, parentId: string | null = null) {
  const found = await prisma.node.findFirst({ where: { ownerId, parentId, name, deletedAt: null } });
  return found ?? prisma.node.create({ data: { ownerId, parentId, name, type: 'FOLDER' } });
}

async function file(ownerId: string, parentId: string | null, name: string, mimeType: string, body: Buffer) {
  const found = await prisma.node.findFirst({ where: { ownerId, parentId, name, deletedAt: null } });
  if (found) return found;
  const node = await prisma.node.create({ data: { ownerId, parentId, name, type: 'FILE', mimeType, kind: fileKind(mimeType, name), size: BigInt(body.length), versionCount: 1 } });
  const key = `u/${ownerId}/seed-${node.id}`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mimeType }));
  const v = await prisma.fileVersion.create({ data: { nodeId: node.id, storageKey: key, size: BigInt(body.length), mimeType, uploadedById: ownerId, scanStatus: 'SKIPPED' } });
  let hasThumbnail = false;
  if (mimeType.startsWith('image/')) {
    const tkey = `t/${ownerId}/${v.id}.webp`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: tkey, Body: await sharp(body).resize(320, 320, { fit: 'cover' }).webp().toBuffer(), ContentType: 'image/webp' }));
    await prisma.fileVersion.update({ where: { id: v.id }, data: { thumbnailKey: tkey } });
    hasThumbnail = true;
  }
  await prisma.user.update({ where: { id: ownerId }, data: { usedBytes: { increment: BigInt(body.length) } } });
  return prisma.node.update({ where: { id: node.id }, data: { currentVersionId: v.id, hasThumbnail } });
}

const photo = (hue: string, label: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067"><rect width="100%" height="100%" fill="${hue}"/><text x="80" y="980" font-size="96" font-family="sans-serif" fill="white">${label}</text></svg>`))
    .jpeg({ quality: 80 })
    .toBuffer();

async function main() {
  await syncPlans(prisma);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  const demo = await user('demo@maxcloud.uz', 'Demo Foydalanuvchi', 'demo-password-2026', 's100');
  await user('admin@maxcloud.uz', 'MaxCloud Admin', 'admin-password-2026', 's1000', 'ADMIN');
  const family = await user('family@maxcloud.uz', 'Oila', 'family-password-2026', 's250');

  const photos = await folder(demo.id, 'Photos');
  const trip = await folder(demo.id, 'Samarkand 2026', photos.id);
  await file(demo.id, trip.id, 'Registan.jpg', 'image/jpeg', await photo('#1d6fe0', 'Registan'));
  await file(demo.id, trip.id, 'Shah-i-Zinda.jpg', 'image/jpeg', await photo('#0f9d74', 'Shah-i-Zinda'));
  await file(demo.id, trip.id, 'Bibi-Khanym.jpg', 'image/jpeg', await photo('#c2410c', 'Bibi-Khanym'));
  const docs = await folder(demo.id, 'Documents');
  await file(demo.id, docs.id, 'notes.txt', 'text/plain', Buffer.from('MaxCloud demo notes\n\n- Back up phone photos\n- Share the trip album with family\n'));
  await file(demo.id, null, 'README.txt', 'text/plain', Buffer.from('Welcome to MaxCloud! Drag files here to upload.\n'));

  const shared = await folder(family.id, 'Family album');
  await file(family.id, shared.id, 'Navruz.jpg', 'image/jpeg', await photo('#7c3aed', 'Navruz'));
  await prisma.folderShare.upsert({
    where: { nodeId_granteeId: { nodeId: shared.id, granteeId: demo.id } },
    create: { nodeId: shared.id, granteeId: demo.id, role: 'EDITOR', createdById: family.id },
    update: {},
  });
  await prisma.shareLink.upsert({ where: { token: 'demo-samarkand-album' }, create: { token: 'demo-samarkand-album', nodeId: trip.id, createdById: demo.id }, update: {} });

  console.log('Seeded. Demo login: demo@maxcloud.uz / demo-password-2026  ·  admin@maxcloud.uz / admin-password-2026');
  console.log(`Public link: ${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/s/demo-samarkand-album`);
  console.log(`Demo quota: ${Number(demo.quotaBytes) / GB} GB`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
