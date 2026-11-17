// Button's props. The kit's build puts every component's into one index.d.ts, which imports React's types.
export interface ButtonProps { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'md' | 'sm'; href?: string; disabled?: boolean; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void; children?: React.ReactNode }
export declare function Button(props: ButtonProps): React.ReactElement;
