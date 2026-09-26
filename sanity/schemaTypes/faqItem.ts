import { defineType, defineField } from 'sanity';

/**
 * A player-facing question and the official answer.
 */
export const faqItem = defineType({
  name: 'faqItem',
  title: 'FAQ Item',
  type: 'document',
  fields: [
    defineField({
      name: 'question',
      title: 'Question',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'answer',
      title: 'Answer',
      type: 'text',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'ruleRef',
      title: 'Related Rule Sections',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'ruleSection' }] }],
    }),
    defineField({
      name: 'sourceUrl',
      title: 'Source URL',
      type: 'url',
      description: 'Where players can verify this FAQ entry.',
    }),
  ],
  preview: {
    select: {
      title: 'question',
      subtitle: 'answer',
    },
  },
});