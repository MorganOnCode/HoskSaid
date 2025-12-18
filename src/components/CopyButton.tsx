"use client";

interface CopyButtonProps {
    text: string;
    className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
    const handleCopy = () => {
        navigator.clipboard.writeText(text);
    };

    return (
        <button
            onClick={handleCopy}
            className={className || "text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] flex items-center gap-1"}
        >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Copy
        </button>
    );
}
