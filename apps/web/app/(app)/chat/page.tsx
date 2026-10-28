'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ChatView } from '../../../src/features/chat/ChatView';

function Inner() {
  const id = useSearchParams().get('c') ?? undefined;
  return <ChatView key={id} conversationId={id} />;
}

export default function ChatPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
