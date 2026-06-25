import { motion } from "motion/react";
import { Badge, type BadgeProps } from "@/components/ui/badge";

/**
 * AnimatedCountBadge — wraps a Watermelon Badge with a key-changing motion.div
 * so that changes in numeric value animate with a subtle scale + opacity pop.
 *
 * Usage:
 *   <AnimatedCountBadge count={activeShares.length} variant="default" />
 *
 * Composed entirely from Watermelon Badge + framer-motion.
 */
interface AnimatedCountBadgeProps extends BadgeProps {
  count: number;
}

export function AnimatedCountBadge({
  count,
  className,
  children,
  ...props
}: AnimatedCountBadgeProps) {
  return (
    <motion.div
      key={count}
      initial={{ scale: 1.3, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="inline-flex"
    >
      <Badge className={className} {...props}>
        {children ?? count}
      </Badge>
    </motion.div>
  );
}
