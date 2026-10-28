'use client';

import { useParams } from 'next/navigation';
import { CollectionDetail } from '../../../../src/components/CollectionDetail';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <CollectionDetail id={id} />;
}
