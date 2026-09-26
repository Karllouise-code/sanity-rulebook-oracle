import { defineType, defineField } from 'sanity';

/**
 * A single section of the game's core rulebook.
 */
export const ruleSection = defineType({
  name: 'ruleSection',
  title: 'Rule Section',
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
      name: 'chapter',
      title: 'Chapter',
      type: 'string',
      description: 'Which chapter of the rulebook this section lives in.',
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{ type: 'string' }],
      options: { layout: 'tags' },
    }),
    defineField({
      name: 'body',
      title: 'Body',
      type: 'array',
      of: [{ type: 'block' }],
      description: 'The full rule text. This is what the Knowledge Base indexes.',
      validation: (rule) => rule.required().min(1),
    }),
    defineField({
      name: 'relatedSections',
      title: 'Related Sections',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'ruleSection' }] }],
    }),
  ],
  preview: {
    select: {
      title: 'title',
      subtitle: 'chapter',
    },
  },
});