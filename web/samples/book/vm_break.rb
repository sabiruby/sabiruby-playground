def m; [1, 2].each { |x| break x * 10 }; end
p m
pr = proc { break 1 }
def call_it(pr); pr.call; end
begin; call_it(pr); rescue LocalJumpError => e; p e.message; end
def mk2; proc { return 5 }; end
begin; mk2.call; rescue LocalJumpError => e; p e.message; end
