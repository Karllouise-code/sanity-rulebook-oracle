import { defineType, defineField } from 'sanity';

/**
 * A correction or clarification to a published rule.
 *
 * `changeType` is the key field for this challenge when the query the agent
 * runs: 'clarify' means the rulebook text is reworded but still stands;
 * 'override' means the new text contradicts and replaces the rulebook text.
 */
export const errataItem = defineType({
  name: 'errataItem',
  title: 'Errata Item',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: { source: 'title', maxLength: 96 },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'ruleRef',
      title: 'Rule Section',
      type: 'reference',
      to: [{ type: 'ruleSection' }],
      description: 'The rulebook section this errata applies to.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'changeType',
      title: 'Change Type',
      type: 'string',
      options: {
        list: [
          { title: 'Clarifies the rule', value: 'clarify' },
          { title: 'Overrides the rule', value: 'override' },
        ],
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'text',
      title: 'Errata Text',
      type: 'string',
      description:
        'The corrected wording. Start overrides with "OVERRIDE:" so the agent and reviewers can spot them immediately.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'sourceUrl',
      title: 'Source URL',
      type: 'url',
      description: 'Where players can verify this errata (e.g. the errata page).',
    }),
    defineField({
      name: 'effectiveDate',
      title: 'Effective Date',
      type: 'date',
      description: 'When this errata takes effect. Newer dates win on ties.',
    }),
  ],
  preview: {
    select: {
      title: 'title',
      subtitle: 'text',
    },
  },
});