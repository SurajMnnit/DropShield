import crypto from 'crypto';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Hash password with PBKDF2 for deterministic development credentials
 * (Salt: 'dropshield_dev_salt', 100,000 iterations, sha512)
 */
function hashPassword(password: string): string {
  const salt = 'dropshield_dev_salt';
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

export async function runSeed(): Promise<void> {
  const connectionUrl = env.DATABASE_URL;
  const needsSsl = connectionUrl.includes('sslmode=require') || 
                    connectionUrl.includes('neon.tech') || 
                    env.NODE_ENV === 'production';

  const client = new pg.Client({
    connectionString: connectionUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });

  await client.connect();

  try {
    logger.info('Starting DropShield development database seed...');
    await client.query('BEGIN');

    // 1. Users (1 Admin, 3 Buyers)
    // Dev credentials:
    //   Admin: admin@dropshield.internal / Admin@123456
    //   Buyer 1: alice@example.com / Buyer@123456
    //   Buyer 2: bob@example.com / Buyer@123456
    //   Buyer 3: charlie@example.com / Buyer@123456
    const adminPassHash = hashPassword('Admin@123456');
    const buyerPassHash = hashPassword('Buyer@123456');

    logger.info('Seeding users...');
    const userRes = await client.query(`
      INSERT INTO users (id, name, email, password_hash, role)
      VALUES 
        ('00000000-0000-0000-0000-000000000001', 'DropShield Administrator', 'admin@dropshield.internal', $1, 'admin'),
        ('00000000-0000-0000-0000-000000000002', 'Alice Buyer', 'alice@example.com', $2, 'buyer'),
        ('00000000-0000-0000-0000-000000000003', 'Bob Buyer', 'bob@example.com', $2, 'buyer'),
        ('00000000-0000-0000-0000-000000000004', 'Charlie Buyer', 'charlie@example.com', $2, 'buyer')
      ON CONFLICT (id) DO UPDATE SET 
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role
      RETURNING id, name, email, role;
    `, [adminPassHash, buyerPassHash]);
    logger.info(`Seeded ${userRes.rowCount} users.`);

    // 2. Venues (2 Venues)
    // Venue 1: Nexus Grand Arena (Bengaluru)
    // Venue 2: Cyberdome Metropolis (Hyderabad)
    logger.info('Seeding venues...');
    const venueRes = await client.query(`
      INSERT INTO venues (id, name, address, city, state, country)
      VALUES 
        ('10000000-0000-0000-0000-000000000001', 'Nexus Grand Arena', 'Outer Ring Road, Marathahalli', 'Bengaluru', 'Karnataka', 'India'),
        ('10000000-0000-0000-0000-000000000002', 'Cyberdome Metropolis', 'Hitech City, Madhapur', 'Hyderabad', 'Telangana', 'India')
      ON CONFLICT (id) DO UPDATE SET 
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        country = EXCLUDED.country
      RETURNING id, name, city;
    `);
    logger.info(`Seeded ${venueRes.rowCount} venues.`);

    // 3. Venue Seats (Generate realistic layouts: VIP & General Admission)
    logger.info('Seeding venue seats...');
    // We generate 50 physical seats per venue for development/benchmarking
    const venue1Id = '10000000-0000-0000-0000-000000000001';
    const venue2Id = '10000000-0000-0000-0000-000000000002';

    for (const vId of [venue1Id, venue2Id]) {
      // 2 Sections: VIP (Rows A-B, 5 seats each = 10 seats), GENERAL (Rows C-F, 10 seats each = 40 seats)
      for (const row of ['A', 'B']) {
        for (let num = 1; num <= 5; num++) {
          await client.query(`
            INSERT INTO venue_seats (venue_id, section, row_label, seat_number, seat_type)
            VALUES ($1, 'VIP', $2, $3, 'VIP')
            ON CONFLICT (venue_id, section, row_label, seat_number) DO NOTHING;
          `, [vId, row, num.toString()]);
        }
      }
      for (const row of ['C', 'D', 'E', 'F']) {
        for (let num = 1; num <= 10; num++) {
          await client.query(`
            INSERT INTO venue_seats (venue_id, section, row_label, seat_number, seat_type)
            VALUES ($1, 'GENERAL', $2, $3, 'STANDARD')
            ON CONFLICT (venue_id, section, row_label, seat_number) DO NOTHING;
          `, [vId, row, num.toString()]);
        }
      }
    }
    const seatCountRes = await client.query('SELECT COUNT(*) as count FROM venue_seats;');
    logger.info(`Total venue physical seats in database: ${seatCountRes.rows[0].count}`);

    // 4. Events
    logger.info('Seeding events...');
    const eventRes = await client.query(`
      INSERT INTO events (id, title, description, category, status)
      VALUES 
        ('20000000-0000-0000-0000-000000000001', 'Electric Symphony 2026', 'Flagship electronic music festival featuring global artists.', 'Concert', 'PUBLISHED'),
        ('20000000-0000-0000-0000-000000000002', 'Global Tech Summit 2026', 'Premier distributed systems and AI architecture conference.', 'Conference', 'PUBLISHED')
      ON CONFLICT (id) DO UPDATE SET 
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        status = EXCLUDED.status
      RETURNING id, title;
    `);
    logger.info(`Seeded ${eventRes.rowCount} events.`);

    // 5. Event Sessions
    logger.info('Seeding event sessions...');
    const now = new Date();
    const session1Start = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
    const session1End = new Date(session1Start.getTime() + 4 * 60 * 60 * 1000); // 4 hours duration

    const session2Start = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days from now
    const session2End = new Date(session2Start.getTime() + 6 * 60 * 60 * 1000); // 6 hours duration

    const sessionRes = await client.query(`
      INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
      VALUES 
        ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', $1, $2, 'OPEN'),
        ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', $3, $4, 'OPEN')
      ON CONFLICT (id) DO UPDATE SET 
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        status = EXCLUDED.status
      RETURNING id;
    `, [session1Start.toISOString(), session1End.toISOString(), session2Start.toISOString(), session2End.toISOString()]);
    logger.info(`Seeded ${sessionRes.rowCount} event sessions.`);

    // 6. Session Seats Inventory (Generate per-session inventory from venue seats)
    logger.info('Generating session seat inventory from venue physical seats...');
    for (const row of sessionRes.rows) {
      const sessionId = row.id;
      // Get the venue_id for this session
      const sessInfo = await client.query('SELECT venue_id FROM event_sessions WHERE id = $1', [sessionId]);
      const vId = sessInfo.rows[0].venue_id;

      // Populate session_seats with pricing: VIP = 500000 paise (Rs 5000), GENERAL = 150000 paise (Rs 1500)
      await client.query(`
        INSERT INTO session_seats (event_session_id, venue_id, venue_seat_id, status, price_minor)
        SELECT 
          $1,
          $2, 
          vs.id, 
          'AVAILABLE', 
          CASE WHEN vs.seat_type = 'VIP' THEN 500000 ELSE 150000 END
        FROM venue_seats vs
        WHERE vs.venue_id = $2
        ON CONFLICT (event_session_id, venue_seat_id) DO NOTHING;
      `, [sessionId, vId]);
    }

    const sessionSeatCount = await client.query('SELECT COUNT(*) as count FROM session_seats;');
    logger.info(`Total active session seats in inventory: ${sessionSeatCount.rows[0].count}`);

    await client.query('COMMIT');
    logger.info('DropShield seed completed successfully.');
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Seeding failed:', msg);
    throw err;
  } finally {
    await client.end();
  }
}

// CLI runner
if (process.argv[1] && process.argv[1].includes('seed.ts')) {
  runSeed().catch((err) => {
    console.error('Seed execution error:', err.message);
    process.exit(1);
  });
}
