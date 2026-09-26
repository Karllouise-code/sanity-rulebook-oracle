// Seeds the Rulebook Oracle dataset with the Steeldusk ruleset.
//
//   node seed/seed.js            # real run (needs SANITY_PROJECT_ID + SANITY_TOKEN)
//   node seed/seed.js --dry-run  # print the plan without calling the API
//
// Idempotent: each document uses a deterministic _id, written with
// createOrReplace, so re-running updates content instead of duplicating it.
//
// Env vars (see ../.env.example):
//   SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN

import { createClient } from '@sanity/client';
import { ruleSections, errataItems, faqItems } from './content.js';

const projectId = process.env.SANITY_PROJECT_ID ?? '';
const dataset = process.env.SANITY_DATASET ?? 'production';
const token = process.env.SANITY_TOKEN ?? '';
const dryRun = process.argv.includes('--dry-run') || !projectId || !token;

// Portable Text block for the ruleSection body.
function toBlocks(text) {
  return [
    {
      _type: 'block',
      style: 'normal',
      markDefs: [],
      children: [{ _type: 'span', text, marks: [] }],
    },
  ];
}

function ruleRef(slug) {
  return { _type: 'reference', _ref: `ruleSection.${slug}` };
}

function ruleSectionDoc(section) {
  return {
    _id: `ruleSection.${section.slug}`,
    _type: 'ruleSection',
    title: section.title,
    slug: { _type: 'slug', current: section.slug },
    chapter: section.chapter,
    tags: section.tags ?? [],
    body: toBlocks(section.body),
    relatedSections: (section.related ?? []).map(ruleRef),
  };
}

function errataDoc(item) {
  return {
    _id: `errataItem.${item.slug}`,
    _type: 'errataItem',
    title: item.title,
    slug: { _type: 'slug', current: item.slug },
    ruleRef: ruleRef(item.ruleRef),
    changeType: item.changeType,
    text: item.text,
    sourceUrl: item.sourceUrl ?? undefined,
    effectiveDate: item.effectiveDate ?? undefined,
  };
}

function faqDoc(item) {
  return {
    _id: `faqItem.${item.slug}`,
    _type: 'faqItem',
    question: item.question,
    answer: item.answer,
    ruleRef: (item.ruleRef ?? []).map(ruleRef),
    sourceUrl: item.sourceUrl ?? undefined,
  };
}

function summarize(docs) {
  const counts = { ruleSection: 0, errataItem: 0, faqItem: 0 };
  for (const doc of docs) counts[doc._type] += 1;
  const overrides = docs.filter(
    (doc) => doc._type === 'errataItem' && doc.changeType === 'override'
  ).length;
  return { counts, overrides };
}

async function main() {
  const docs = [
    ...ruleSections.map(ruleSectionDoc),
    ...errataItems.map(errataDoc),
    ...faqItems.map(faqDoc),
  ];
  const { counts, overrides } = summarize(docs);

  console.log('Rulebook Oracle seed plan');
  console.log(`  ruleSection x${counts.ruleSection}`);
  console.log(`  errataItem  x${counts.errataItem} (${overrides} override, ${
    counts.errataItem - overrides
  } clarify)`);
  console.log(`  faqItem     x${counts.faqItem}`);
  console.log(`  projectId   ${projectId || '(unset)'} | dataset ${dataset}`);

  if (overrides < 1) {
    console.error('ABORT: the seed must contain at least one errata override.');
    process.exit(1);
  }

  if (dryRun) {
    console.log(
      '\nDry run: nothing written. Set SANITY_PROJECT_ID and SANITY_TOKEN (or pass --dry-run) to run for real.'
    );
    return;
  }

  const client = createClient({
    projectId,
    dataset,
    token,
    apiVersion: '2025-01-01',
    useCdn: false,
  });

  console.log('\nWriting documents (atomic transaction)...');
  const tx = client.transaction();
  for (const doc of docs) tx.createOrReplace(doc);
  await tx.commit();
  console.log('Done. 57 documents upserted.');

  const verify = await client.fetch(
    `{ "sections": count(*[_type == "ruleSection"]), "errata": count(*[_type == "errataItem"]), "faqs": count(*[_type == "faqItem"]) }`
  );
  console.log('Verify counts:', JSON.stringify(verify));

  console.log('\nGreat demo questions for the agent chat:');
  for (const [i, q] of [
    'Can I attack twice if I wield two short swords?',
    'What happens when my Health hits 0?',
    'Does advantage from high ground stack with advantage from a spell?',
    'Is a natural 6 always a hit?',
    'How many actions do I get on my turn?',
  ].entries()) {
    console.log(`  ${i + 1}. ${q}`);
  }
}

main().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});