def r(n); r(n + 1); end
begin; r(0); rescue SystemStackError => e; p e.class; end
def deep(n); n == 0 ? 0 : 1 + deep(n - 1); end
p deep(400)
begin; p deep(600); rescue SystemStackError => e; p [:deep600, e.class]; end
