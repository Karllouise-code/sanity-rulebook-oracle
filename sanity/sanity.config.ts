import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { schemaTypes } from './schemaTypes';

// projectId comes from the environment (see .env.example). Running
// `sanity init` in this folder also writes it into sanity.cli.ts.
const projectId = process.env.SANITY_PROJECT_ID ?? '';
const dataset = process.env.SANITY_DATASET ?? 'production';

export default defineConfig({
  name: 'rulebook-oracle',
  title: 'Rulebook Oracle',
  projectId,
  dataset,
  plugins: [structureTool()],
  schema: { types: schemaTypes },
});