import type { UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import { ToolCallCard } from '@/components/chat/tool-call-card';
import { BotIcon, UserIcon } from 'lucide-react';

interface MessageBubbleProps {
  message: UIMessage;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  // Separate parts into text and tools
  const textParts = message.parts.filter(
    (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
  );
  const toolParts = message.parts.filter(
    (p) => p.type === 'dynamic-tool' || (typeof p.type === 'string' && p.type.startsWith('tool-'))
  );
  const text = textParts.map((p) => p.text).join('');
  const hasContent = text || toolParts.length > 0;

  return (
    <div
      className={cn(
        'flex items-start gap-3 py-3',
        isUser && 'flex-row-reverse'
      )}
    >
      <Avatar size="sm">
        <AvatarFallback
          className={cn(
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {isUser ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
        </AvatarFallback>
      </Avatar>

      <div className={cn('max-w-[80%]', isUser && 'text-right')}>
        {/* Tool call cards (assistant only) */}
        {!isUser && toolParts.map((part: any) => (
          <ToolCallCard
            key={part.toolCallId}
            toolName={part.toolName}
            state={part.state}
            input={part.input}
            output={'output' in part ? part.output : undefined}
            errorText={'errorText' in part ? part.errorText : undefined}
          />
        ))}

        {/* Text bubble */}
        {(text || (isStreaming && !hasContent)) && (
          <div
            className={cn(
              'rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
              isUser
                ? 'bg-primary text-primary-foreground rounded-tr-sm'
                : 'bg-muted text-foreground rounded-tl-sm'
            )}
          >
            {text || <Spinner className="size-4" />}
          </div>
        )}
      </div>
    </div>
  );
}
