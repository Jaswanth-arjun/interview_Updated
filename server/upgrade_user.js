// ─── Upgrade Admin Users Script ──────────────────────────────
const { PrismaClient } = require('@prisma/client');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const prisma = new PrismaClient();

async function main() {
  const adminEmailsStr = process.env.ADMIN_EMAILS || '';
  const adminEmails = adminEmailsStr.split(',').map(e => e.trim()).filter(Boolean);

  if (adminEmails.length === 0) {
    console.error('❌ No ADMIN_EMAILS found in server/.env file.');
    return;
  }

  console.log(`🔍 Found admin emails in .env: ${adminEmails.join(', ')}`);

  for (const email of adminEmails) {
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        console.log(`⚠️ User with email "${email}" does not exist in the database yet. They will be set as admin automatically when they log in for the first time.`);
        continue;
      }

      const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: {
          isAdmin: true,
          tier: 'pro',
          walletBalancePaise: 99999999, // ₹999,999.99
        },
      });

      console.log(`✅ Successfully upgraded user: ${email}`);
      console.log(`   - ID: ${updatedUser.id}`);
      console.log(`   - Tier: ${updatedUser.tier}`);
      console.log(`   - Balance: ₹${(updatedUser.walletBalancePaise / 100).toFixed(2)}`);
      console.log(`   - isAdmin: ${updatedUser.isAdmin}`);
    } catch (err) {
      console.error(`❌ Failed to upgrade user "${email}":`, err.message);
    }
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
