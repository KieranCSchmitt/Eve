export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`eve-logo ${small ? "small" : ""}`} aria-label="Eve">
      <svg
        width="30"
        height="29"
        viewBox="0 0 40 38"
        role="img"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="eve-blue" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#7093ff" />
            <stop offset="1" stopColor="#5378ff" />
          </linearGradient>
        </defs>
        <path
          d="M1 16C1 7.2 6.9 1 15.3 1H34.4C37.4 1 39 2.9 39 5.5S36.6 10.5 33.4 10.5H10.6C6.6 10.5 3.3 12.4 1 16Z M1 24C1 17.8 4.9 14.2 11 14.2H24.5C27.7 14.2 29.4 16.1 29.4 18.8S27.1 23.3 24.2 23.3H1Z M1 26C3.4 29.2 6.6 30.1 11.2 30.1H33.6C36.9 30.1 39 32 39 34.5S37.3 38 34.3 38H15C6.6 38 1 33.7 1 26Z"
          fill="url(#eve-blue)"
        />
      </svg>
      {!small && <span className="wordmark">eve</span>}
    </span>
  );
}
