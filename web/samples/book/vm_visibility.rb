class A
  private def f; end
  protected def g; end
end
begin; A.new.f; rescue NoMethodError => e; p e.message; end
begin; A.new.g; rescue NoMethodError => e; p e.message; end
