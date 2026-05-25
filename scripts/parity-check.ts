import { config } from 'dotenv';
config();
import { sql } from '../src/lib/db';

const REST = `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, '')}/rest/v1`;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Accept-Profile': 'public' };

const TABLES = ['channels', 'videos', 'transcripts', 'tags', 'video_tags',
                'transcript_chunks', 'error_reports', 'ingestion_logs'];

// video_tags is a junction table with a composite PK and no `id` column,
// so count via a column that always exists on every table.
const COUNT_COL: Record<string, string> = { video_tags: 'video_id' };

async function supaCount(table: string): Promise<number> {
    const col = COUNT_COL[table] ?? 'id';
    const res = await fetch(`${REST}/${table}?select=${col}`, {
        headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
    });
    // PostgREST returns total in Content-Range: 0-0/<total>
    const cr = res.headers.get('content-range') || '';
    return parseInt(cr.split('/')[1] || '0', 10);
}

async function localCount(table: string): Promise<number> {
    const [r] = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM ${sql(table)}`;
    return r.c;
}

(async () => {
    console.log('table'.padEnd(20), 'supabase'.padStart(10), 'local'.padStart(10), '  match');
    let allMatch = true;
    for (const t of TABLES) {
        const [s, l] = await Promise.all([supaCount(t), localCount(t)]);
        const ok = s === l;
        if (!ok) allMatch = false;
        console.log(t.padEnd(20), String(s).padStart(10), String(l).padStart(10), '  ' + (ok ? 'OK' : 'MISMATCH'));
    }

    // Spot-check: embedding integrity on a sample chunk
    const [chunk] = await sql<{ id: string; dims: number }[]>`
        SELECT id, vector_dims(embedding) AS dims
        FROM transcript_chunks WHERE embedding IS NOT NULL LIMIT 1
    `;
    console.log('\nembedding spot-check:', chunk ? `chunk ${chunk.id.slice(0,8)} has ${chunk.dims} dims (expect 1536)` : 'no chunks');

    // Spot-check: a transcript's raw_text length matches between sides
    const [lt] = await sql<{ youtube_id: string; len: number }[]>`
        SELECT v.youtube_id, length(t.raw_text) AS len
        FROM transcripts t JOIN videos v ON v.id = t.video_id
        WHERE t.raw_text IS NOT NULL ORDER BY length(t.raw_text) DESC LIMIT 1
    `;
    if (lt) {
        const res = await fetch(`${REST}/videos?youtube_id=eq.${lt.youtube_id}&select=id`, { headers: H });
        const [vrow] = await res.json() as { id: string }[];
        const tr = await fetch(`${REST}/transcripts?video_id=eq.${vrow.id}&select=raw_text`, { headers: H });
        const [trow] = await tr.json() as { raw_text: string }[];
        const supaLen = trow?.raw_text?.length ?? 0;
        console.log(`raw_text spot-check: ${lt.youtube_id} local=${lt.len} supabase=${supaLen}`,
                    lt.len === supaLen ? 'OK' : 'MISMATCH');
    }

    console.log('\n' + (allMatch ? '✅ ALL ROW COUNTS MATCH' : '⚠️  ROW COUNT MISMATCH — investigate'));
    await sql.end({ timeout: 3 });
})().catch(async (e) => { console.error('FAIL', e); await sql.end({ timeout: 3 }); process.exit(1); });
