# 整数と浮動小数点数の挙動（組込みクラスの章）。mruby 4.1.0-rc、Word Boxing、MRB_USE_BIGINT
p [2**62 - 1, (2**62).class, 2**63, (2**62).frozen?]
p [7 / 2, -7 / 2, 7 / -2, 7 % -2, -7 % 2, 7.divmod(-2)]
p [7.fdiv(2), 1 / 0.0, (0.0 / 0.0).nan?]
p [0.1 + 0.2, 1e16, 1e15, 100.0, 1.0e-5, 123456789.123456789]
p [2.5.round, 3.5.round, -2.5.round, 2.5.to_i, Float::DIG]
p [Integer("0x1f", 16), "0b101".to_i(0), "12abc".to_i, "abc".to_i]
begin; 1 / 0; rescue => e; p e.class; end
