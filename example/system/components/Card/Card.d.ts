// Card's props, and its header's.
export interface CardProps { title?: string; actions?: React.ReactNode; collapsible?: boolean; defaultOpen?: boolean; children?: React.ReactNode }
export declare function Card(props: CardProps): React.ReactElement;
export interface CardHeaderProps { title: string; actions?: React.ReactNode; open?: boolean; onToggle?: () => void }
export declare function CardHeader(props: CardHeaderProps): React.ReactElement;
