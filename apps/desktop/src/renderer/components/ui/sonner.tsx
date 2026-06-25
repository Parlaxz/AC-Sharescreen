import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      theme="dark"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-2 group-[.toaster]:text-text-primary group-[.toaster]:border-border-subtle group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-text-secondary",
          actionButton:
            "group-[.toast]:bg-accent group-[.toast]:text-white",
          cancelButton:
            "group-[.toast]:bg-surface-3 group-[.toast]:text-text-muted",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
