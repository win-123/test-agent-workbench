package com.example.war;

public class DemoService {
    public String choose(boolean enabled, String value) {
        try {
            if (enabled) {
                return helper(value);
            }
            throw new IllegalArgumentException("disabled");
        } catch (RuntimeException error) {
            throw new IllegalStateException("wrapped", error);
        }
    }

    private String helper(String value) {
        return value.trim();
    }
}
