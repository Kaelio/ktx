/** Converts an Atlassian Document Format (ADF) node tree to GitHub-flavored Markdown. */

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

function applyMarks(text: string, marks: AdfMark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  let result = text;
  for (const mark of marks) {
    if (mark.type === 'strong') result = `**${result}**`;
    else if (mark.type === 'em') result = `_${result}_`;
    else if (mark.type === 'code') result = `\`${result}\``;
    else if (mark.type === 'strike') result = `~~${result}~~`;
    else if (mark.type === 'link') {
      const href = String(mark.attrs?.href ?? '');
      result = href ? `[${result}](${href})` : result;
    }
  }
  return result;
}

function convertNode(node: AdfNode, context: { listDepth: number; orderedIndex: number[] }): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map((child) => convertNode(child, context)).join('');

    case 'paragraph': {
      const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('');
      return inner.trim() ? `${inner}\n\n` : '';
    }

    case 'text':
      return applyMarks(node.text ?? '', node.marks);

    case 'hardBreak':
      return '  \n';

    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const prefix = '#'.repeat(Math.min(level, 6));
      const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('');
      return `${prefix} ${inner.trim()}\n\n`;
    }

    case 'bulletList': {
      const childCtx = { ...context, listDepth: context.listDepth + 1 };
      return (node.content ?? []).map((child) => convertNode(child, childCtx)).join('') + '\n';
    }

    case 'orderedList': {
      const childCtx = { ...context, listDepth: context.listDepth + 1, orderedIndex: [...context.orderedIndex, 0] };
      return (node.content ?? []).map((child) => convertNode(child, childCtx)).join('') + '\n';
    }

    case 'listItem': {
      const indent = '  '.repeat(context.listDepth - 1);
      const isOrdered = context.orderedIndex.length > 0;
      if (isOrdered) {
        context.orderedIndex[context.orderedIndex.length - 1] += 1;
        const num = context.orderedIndex[context.orderedIndex.length - 1];
        const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('').trim();
        return `${indent}${num}. ${inner}\n`;
      }
      const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('').trim();
      return `${indent}- ${inner}\n`;
    }

    case 'codeBlock': {
      const lang = String(node.attrs?.language ?? '');
      const inner = (node.content ?? []).map((child) => child.text ?? '').join('');
      return `\`\`\`${lang}\n${inner}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('');
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n') + '\n';
    }

    case 'rule':
      return '---\n\n';

    case 'inlineCard': {
      const url = String(node.attrs?.url ?? '');
      return url ? `[${url}](${url})` : '';
    }

    case 'mention': {
      const text = String(node.attrs?.text ?? node.attrs?.id ?? '');
      return `@${text}`;
    }

    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');

    case 'table': {
      const rows = (node.content ?? []).filter((n) => n.type === 'tableRow');
      if (rows.length === 0) return '';
      const rendered = rows.map((row) => {
        const cells = (row.content ?? []).map((cell) =>
          (cell.content ?? []).map((child) => convertNode(child, context)).join('').replace(/\n+/g, ' ').trim(),
        );
        return `| ${cells.join(' | ')} |`;
      });
      const separator = `| ${rows[0].content?.map(() => '---').join(' | ')} |`;
      return [rendered[0], separator, ...rendered.slice(1)].join('\n') + '\n\n';
    }

    case 'tableRow':
    case 'tableHeader':
    case 'tableCell':
      return (node.content ?? []).map((child) => convertNode(child, context)).join('');

    case 'panel': {
      const panelType = String(node.attrs?.panelType ?? 'info');
      const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('');
      return `> **${panelType.toUpperCase()}**\n> ${inner.trim()}\n\n`;
    }

    case 'expand': {
      const title = String(node.attrs?.title ?? '');
      const inner = (node.content ?? []).map((child) => convertNode(child, context)).join('');
      return title ? `**${title}**\n\n${inner}` : inner;
    }

    default:
      return (node.content ?? []).map((child) => convertNode(child, context)).join('');
  }
}

export function adfToMarkdown(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const result = convertNode(adf as AdfNode, { listDepth: 0, orderedIndex: [] });
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
